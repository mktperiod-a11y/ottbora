/**
 * 영화진흥위원회(KOFIC) 오픈API 에서 일별 박스오피스를 받아
 * assets/boxoffice.json 에 누적합니다.
 *
 * 실행:
 *   KOFIC_API_KEY=... node scripts/fetch-boxoffice.mjs            하루치(전날)
 *   KOFIC_API_KEY=... node scripts/fetch-boxoffice.mjs --days=28  지난 28일치
 *
 * 하루치만 받으면 10편뿐이라 목록이 되지 않습니다. 그래서 받은 날짜를
 * 덮어쓰지 않고 작품 단위로 합칩니다. 같은 작품이 여러 날 나오면
 * 처음 본 날 / 마지막으로 본 날 / 오른 날 수를 갱신합니다.
 *
 * 이 스크립트는 응답 형태를 먼저 검증합니다. API 가 예상과 다른 모양을 주면
 * 파일을 건드리지 않고 실제로 받은 구조를 출력한 뒤 종료합니다.
 * 잘못된 데이터가 사이트에 실리는 것보다 갱신이 멈추는 편이 낫기 때문입니다.
 */

import { writeFile, readFile } from "node:fs/promises";

const KEY = process.env.KOFIC_API_KEY;
const OUT = "assets/boxoffice.json";
const ENDPOINT =
  "https://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice/searchDailyBoxOfficeList.json";
const DETAIL_ENDPOINT =
  "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieInfo.json";

/*
 * 애니 탭은 MyAnimeList 쪽(scripts/fetch-anime.mjs)에서 채웁니다.
 * 그 탭은 "극장 개봉"이 아니라 "지금 화제인 애니" 기준이라, 여기서 오는
 * 극장 애니메이션은 애니로 따로 묶지 않고 영화로 둡니다.
 * 장르 목록에 "애니메이션" 이 남아 있어 정보는 잃지 않습니다.
 */

/**
 * 마지막으로 차트에 오른 지 이 일수가 지나면 목록에서 내립니다.
 * 내려간 작품은 예매할 수 없으니 남겨 둘 이유가 없습니다.
 */
const KEEP_DAYS = 45;

/** 한 번에 거슬러 올라갈 수 있는 최대 일수. 실수로 API 를 과하게 두드리지 않도록. */
const MAX_DAYS = 60;

if (!KEY) {
  console.error("KOFIC_API_KEY 가 없습니다. 저장소 Secrets 에 등록하세요.");
  process.exit(1);
}

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = Math.min(
  MAX_DAYS,
  Math.max(1, Number(daysArg?.slice(7)) || 1),
);

/** KOFIC 는 전날 집계를 제공합니다. 집계 기준이 한국 시간이라 KST 로 환산해 셉니다. */
function kstDateBefore(days) {
  const t = Date.now() + 9 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

/** "20260920" 사이의 날짜 차이(일). 둘 다 KST 기준 날짜 문자열입니다. */
function daysBetween(a, b) {
  const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((p(a) - p(b)) / 86400000);
}

function fail(msg, got) {
  console.error("KOFIC 응답이 예상과 다릅니다:", msg);
  if (got !== undefined) {
    console.error("받은 구조:", JSON.stringify(got, null, 2).slice(0, 1200));
  }
  console.error("\n기존 " + OUT + " 은 그대로 두었습니다.");
  process.exit(1);
}

/**
 * KOFIC 에 붙습니다. 연결이 실패하거나 느릴 때가 있어 몇 번 다시 시도합니다.
 * 응답 이상과 달리 연결 실패는 상대 사정이라, 재시도 후에도 안 되면
 * 그대로 멈추고 기존 파일을 유지합니다.
 */
async function getJson(url, label, { attempts = 3, timeout = 20000 } = {}) {
  const ATTEMPTS = attempts;
  let last;
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    try {
      return await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      last = e;
      const why = e?.cause?.code || e?.name || e?.message;
      console.warn(`  ${label} 연결 실패 (${i}/${ATTEMPTS}): ${why}`);
      if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, i * 3000));
    }
  }
  throw last;
}

/** 하루치를 조회합니다. 아직 집계 전이면 빈 목록이 오므로 null 을 돌려줍니다. */
async function fetchDay(targetDt) {
  const url = `${ENDPOINT}?key=${encodeURIComponent(KEY)}&targetDt=${targetDt}`;
  let res;
  try {
    res = await getJson(url, `박스오피스 ${targetDt}`);
  } catch (e) {
    fail(
      `KOFIC 에 연결하지 못했습니다 (${e?.cause?.code || e?.name}). ` +
        "일시적인 장애일 수 있으니 잠시 뒤 다시 실행해 보세요.",
    );
  }
  if (!res.ok) fail(`HTTP ${res.status} (targetDt=${targetDt})`);

  let body;
  try {
    body = await res.json();
  } catch {
    fail(
      "JSON 이 아닙니다. KOFIC_API_KEY 가 없거나 잘못되면 HTML 오류 페이지가 옵니다. " +
        "저장소 Secrets 의 이름이 정확히 KOFIC_API_KEY 인지 확인하세요.",
    );
  }
  if (body?.faultInfo) {
    fail(body.faultInfo.message || "faultInfo 반환 (키를 확인하세요)", body.faultInfo);
  }

  const list = body?.boxOfficeResult?.dailyBoxOfficeList;
  if (!Array.isArray(list)) {
    fail("boxOfficeResult.dailyBoxOfficeList 가 배열이 아님", body);
  }
  return list.length ? list : null;
}

/**
 * 이전 파일을 읽어 movieCd 로 찾을 수 있게 돌려줍니다.
 * 누적 이전의 옛 형식(하루치만 담긴 파일)도 그대로 받아들입니다.
 * 파일이 없거나 깨져 있으면 빈 상태에서 시작합니다 — 다시 모으면 되기 때문입니다.
 */
async function loadPrev() {
  let raw;
  try {
    raw = await readFile(OUT, "utf8");
  } catch {
    return new Map();
  }

  let prev;
  try {
    prev = JSON.parse(raw);
  } catch {
    console.warn(`${OUT} 을 읽지 못해 새로 모읍니다.`);
    return new Map();
  }

  const movies = Array.isArray(prev?.movies) ? prev.movies : [];
  const out = new Map();
  for (const m of movies) {
    if (!m?.movieCd) continue;
    // 옛 형식에는 firstSeenAt 이 없고 그 파일이 받은 날짜(targetDt)만 있습니다.
    const seen = m.lastSeenAt || prev.targetDt || "";
    out.set(String(m.movieCd), {
      movieCd: String(m.movieCd),
      title: String(m.title || ""),
      openedAt: m.openedAt || "",
      audienceAcc: m.audienceAcc ?? null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      type: m.type || "영화",
      firstSeenAt: m.firstSeenAt || seen,
      lastSeenAt: seen,
      days: Number(m.days) || 1,
      bestRank: Number(m.bestRank) || Number(m.rank) || 99,
      rank: null,
    });
  }
  return out;
}

/**
 * 작품 상세에서 장르를 받아 옵니다.
 * 이 호출은 보조 정보라, 실패해도 그 작품만 장르 없이 두고 넘어갑니다.
 * 목록 자체가 날아가는 편보다 장르 한 칸이 비는 편이 낫기 때문입니다.
 */
async function fetchGenres(movieCd) {
  const url = `${DETAIL_ENDPOINT}?key=${encodeURIComponent(KEY)}&movieCd=${encodeURIComponent(movieCd)}`;
  // 장르는 없어도 목록이 서는 보조 정보입니다. 한 편에 오래 매달리지 않도록
  // 목록 조회보다 짧게 끊고, 실패하면 다음 실행에서 다시 시도합니다.
  const res = await getJson(url, `상세 ${movieCd}`, { attempts: 2, timeout: 8000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.faultInfo) throw new Error(body.faultInfo.message || "faultInfo");
  const info = body?.movieInfoResult?.movieInfo;
  // 확인된 movieInfo 필드 (2026-09-21 실행 기준):
  //   movieCd, movieNm, movieNmEn, movieNmOg, showTm, prdtYear, openDt,
  //   prdtStatNm, typeNm, nations, genres, directors, actors, showTypes,
  //   companys, audits, staffs
  // 포스터·이미지 필드는 없습니다. 이미지는 다른 곳에서 구해야 합니다.
  const genres = info?.genres;
  if (!Array.isArray(genres)) throw new Error("movieInfoResult.movieInfo.genres 없음");
  return genres.map((g) => String(g.genreNm || "")).filter(Boolean);
}

// ---- 1. 날짜별로 받아서 작품 단위로 합치기 -------------------------------

const movies = await loadPrev();
const before = movies.size;
const fetched = [];

for (let back = 1; back <= DAYS; back += 1) {
  const targetDt = kstDateBefore(back);
  const list = await fetchDay(targetDt);
  if (!list) {
    // 전날 집계가 아직 안 올라온 시각일 수 있습니다. 하루치만 받는 중이라면
    // 하루 더 거슬러 올라가고, 여러 날을 훑는 중이라면 그 날만 건너뜁니다.
    console.log(`${targetDt} 집계 없음 — 건너뜁니다.`);
    if (DAYS === 1) {
      const retryDt = kstDateBefore(2);
      const retry = await fetchDay(retryDt);
      if (!retry) fail(`최근 2일간 집계가 비어 있습니다 (${targetDt}, ${retryDt})`);
      fetched.push({ targetDt: retryDt, list: retry });
    }
    continue;
  }
  fetched.push({ targetDt, list });
  if (DAYS > 1) await new Promise((r) => setTimeout(r, 200));
}

if (!fetched.length) fail(`${DAYS}일을 훑었지만 집계가 하나도 없습니다.`);

const REQUIRED = ["rank", "movieCd", "movieNm"];
const sample = fetched[0].list[0];
const missing = REQUIRED.filter((f) => !(f in sample));
if (missing.length) fail("항목에 " + missing.join(", ") + " 필드가 없음", sample);

const latestDt = fetched[0].targetDt;

// 날짜별 행을 작품 단위로 먼저 모읍니다. 하루씩 바로 합치면, 이미 알고 있는
// 기간 안쪽으로 거슬러 올라갈 때 오른 날 수를 잘못 세게 됩니다.
const seen = new Map(); // movieCd -> { dates, top, row, rowDt }
for (const { targetDt, list } of fetched) {
  for (const m of list) {
    const movieCd = String(m.movieCd);
    let e = seen.get(movieCd);
    if (!e) seen.set(movieCd, (e = { dates: new Set(), top: 99, row: null, rowDt: "" }));
    e.dates.add(targetDt);
    e.top = Math.min(e.top, Number(m.rank));
    // bestRank 는 기간 중 최고 순위입니다. 화면에 "지금 몇 위"로 쓰려면
    // 마지막 집계일의 순위가 따로 필요합니다.
    if (targetDt === latestDt) e.rankNow = Number(m.rank);
    // 가장 최근 날의 행을 남깁니다. 누적 관객(audiAcc)이 최신값이 되도록.
    if (targetDt > e.rowDt) {
      e.row = m;
      e.rowDt = targetDt;
    }
  }
}

for (const [movieCd, e] of seen) {
  const dates = [...e.dates].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const m = e.row;
  const prev = movies.get(movieCd);

  if (!prev) {
    movies.set(movieCd, {
      movieCd,
      title: String(m.movieNm),
      openedAt: m.openDt || "",
      audienceAcc: m.audiAcc ? Number(m.audiAcc) : null,
      genres: [],
      type: "영화",
      firstSeenAt: first,
      lastSeenAt: last,
      days: dates.length,
      bestRank: e.top,
      // 마지막 집계일에 차트에 없었으면 "지금 순위"는 없습니다.
      rank: e.rankNow ?? null,
    });
    continue;
  }

  // 이미 알고 있던 기간(firstSeenAt~lastSeenAt) 안쪽 날짜는 지난 실행에서 세었습니다.
  // 바깥으로 늘어난 날만 더합니다.
  const fresh = dates.filter((d) => d < prev.firstSeenAt || d > prev.lastSeenAt);
  prev.days += fresh.length;
  if (first < prev.firstSeenAt) prev.firstSeenAt = first;
  if (last > prev.lastSeenAt) prev.lastSeenAt = last;
  prev.bestRank = Math.min(prev.bestRank, e.top);
  prev.rank = e.rankNow ?? null;
  prev.title = String(m.movieNm);
  prev.openedAt = m.openDt || prev.openedAt;
  prev.audienceAcc = m.audiAcc ? Number(m.audiAcc) : prev.audienceAcc;
}

// ---- 2. 오래된 작품 내리기 -----------------------------------------------

let dropped = 0;
for (const [movieCd, m] of movies) {
  if (daysBetween(latestDt, m.lastSeenAt) > KEEP_DAYS) {
    movies.delete(movieCd);
    dropped += 1;
  }
}

// ---- 3. 장르 채우기 (아직 모르는 작품만) ---------------------------------

const needGenre = [...movies.values()].filter((m) => !m.genres.length);
/*
 * 장르 조회는 작품 수만큼 늘어납니다. 며칠치를 한 번에 훑으면 수십 편이
 * 한꺼번에 걸리는데, KOFIC 이 느린 날에는 이 단계만 몇십 분이 됩니다.
 * 시간이 차면 남은 작품은 장르 없이 두고 넘어갑니다. 장르가 빈 작품은
 * 다음 실행에서 다시 조회 대상이 되므로 스스로 메워집니다.
 */
const GENRE_BUDGET_MS = 6 * 60 * 1000;
const genreStart = Date.now();
let failed = 0;
let skipped = 0;
for (const m of needGenre) {
  if (Date.now() - genreStart > GENRE_BUDGET_MS) {
    skipped += 1;
    continue;
  }
  try {
    m.genres = await fetchGenres(m.movieCd);
    m.type = "영화";
  } catch (e) {
    failed += 1;
    console.warn(`  장르 조회 실패 — ${m.title}: ${e.message}`);
    m.genres = [];
    m.type = "영화";
  }
  await new Promise((r) => setTimeout(r, 200)); // 연속 호출 간격
}
if (failed) {
  console.warn(`장르 조회 ${failed}/${needGenre.length}건 실패 — 해당 작품은 영화로 둡니다.`);
}
if (skipped) {
  console.warn(
    `시간이 차서 ${skipped}/${needGenre.length}건은 장르를 비워 뒀습니다. ` +
      "다음 실행에서 다시 조회합니다.",
  );
}

// ---- 4. 정렬하고 저장 ----------------------------------------------------

// 최근까지 걸려 있던 작품이 앞으로 옵니다. 같은 날까지 걸렸다면 더 높이 올라갔던 쪽이 먼저.
// 지금 극장에 걸려 있는 작품이 위에 오게 하려는 정렬입니다.
const sorted = [...movies.values()].sort(
  (a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt) ||
    a.bestRank - b.bestRank ||
    a.title.localeCompare(b.title, "ko"),
);

// showing 은 "마지막 집계일에도 차트에 있었는가" 입니다.
// 예매 링크를 붙일 근거로 쓰므로, 추측하지 않고 이 사실만 기록합니다.
for (const m of sorted) m.showing = m.lastSeenAt === latestDt;

const out = {
  note: "일별 박스오피스를 작품 단위로 누적한 목록입니다. 콘텐츠ZONE 의 영화·애니 탭에서 씁니다.",
  source: "영화진흥위원회 오픈API 일별 박스오피스",
  sourceUrl: "https://www.kobis.or.kr/kobisopenapi/",
  updatedAt: new Date().toISOString().slice(0, 10),
  latestDt,
  keepDays: KEEP_DAYS,
  movies: sorted,
};

// 내용이 같으면 커밋이 생기지 않도록 그대로 둡니다.
// updatedAt 은 매일 바뀌므로 비교에서 뺍니다.
const next = JSON.stringify(out, null, 2) + "\n";
let prevMovies = null;
try {
  prevMovies = JSON.stringify(JSON.parse(await readFile(OUT, "utf8")).movies);
} catch {}

if (prevMovies === JSON.stringify(out.movies)) {
  console.log("변동 없음 — 파일을 그대로 둡니다.");
} else {
  await writeFile(OUT, next);
  const showing = sorted.filter((m) => m.showing).length;
  console.log(
    `${OUT} 갱신: ${sorted.length}편 (새로 ${sorted.length - before + dropped}편, ` +
      `내림 ${dropped}편, 상영 중 ${showing}편, 기준일 ${latestDt})`,
  );
  sorted
    .slice(0, 5)
    .forEach((m) =>
      console.log(`  ${m.title} [${m.type}] ${m.genres.join("·")} — ${m.days}일`),
    );
}
