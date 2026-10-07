
import { writeFile, readFile } from "node:fs/promises";

const KEY = process.env.KOFIC_API_KEY;
const OUT = "assets/boxoffice.json";
const ARCHIVE = "assets/movie-archive.json";
const ENDPOINT =
  "https://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice/searchDailyBoxOfficeList.json";
const DETAIL_ENDPOINT =
  "https://www.kobis.or.kr/kobisopenapi/webservice/rest/movie/searchMovieInfo.json";


const KEEP_DAYS = 45;

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

function kstDateBefore(days) {
  const t = Date.now() + 9 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

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

async function loadPrev(path = OUT) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return new Map();
  }

  let prev;
  try {
    prev = JSON.parse(raw);
  } catch {
    console.warn(`${path} 을 읽지 못해 새로 모읍니다.`);
    return new Map();
  }

  const movies = Array.isArray(prev?.movies) ? prev.movies : [];
  const out = new Map();
  for (const m of movies) {
    if (!m?.movieCd) continue;
    const seen = m.lastSeenAt || prev.targetDt || "";
    out.set(String(m.movieCd), {
      movieCd: String(m.movieCd),
      title: String(m.title || ""),
      titleEn: String(m.titleEn || ""),
      titleOriginal: String(m.titleOriginal || ""),
      openedAt: m.openedAt || "",
      audienceAcc: m.audienceAcc ?? null,
      genres: Array.isArray(m.genres) ? m.genres : [],
      type: m.type || "영화",
      firstSeenAt: m.firstSeenAt || seen,
      lastSeenAt: seen,
      days: Number(m.days) || 1,
      bestRank: Number(m.bestRank) || Number(m.rank) || 99,
      rank: null,
      audienceDay: null,
      runtime: Number(m.runtime) || null,
      directors: Array.isArray(m.directors) ? m.directors : [],
      cast: Array.isArray(m.cast) ? m.cast : [],
      producers: Array.isArray(m.producers) ? m.producers : [],
      distributors: Array.isArray(m.distributors) ? m.distributors : [],
      rating: String(m.rating || ""),
      koficDetailFetched: Boolean(m.koficDetailFetched),
      koficDetailVersion: Number(m.koficDetailVersion) || 1,
      poster: m.poster || "",
      posterCredit: m.posterCredit || "",
      synopsis: m.synopsis || "",
      synopsisCredit: m.synopsisCredit || "",
      tmdbId: m.tmdbId ?? null,
      score: Number(m.score) > 0 ? Number(m.score) : null,
      scoreBy: Number(m.score) > 0 ? m.scoreBy || "" : "",
      voteCount: m.voteCount ?? null,
    });
  }
  return out;
}

async function fetchMovieDetails(movieCd) {
  const url = `${DETAIL_ENDPOINT}?key=${encodeURIComponent(KEY)}&movieCd=${encodeURIComponent(movieCd)}`;
  const res = await getJson(url, `상세 ${movieCd}`, { attempts: 2, timeout: 8000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.faultInfo) throw new Error(body.faultInfo.message || "faultInfo");
  const info = body?.movieInfoResult?.movieInfo;
  if (!info) throw new Error("movieInfoResult.movieInfo 없음");

  const genres = Array.isArray(info.genres)
    ? info.genres.map((g) => String(g.genreNm || "")).filter(Boolean)
    : [];
  const directors = Array.isArray(info.directors)
    ? info.directors.map((x) => String(x.peopleNm || "")).filter(Boolean).slice(0, 3)
    : [];
  const cast = Array.isArray(info.actors)
    ? info.actors.map((x) => String(x.peopleNm || "")).filter(Boolean).slice(0, 6)
    : [];
  const rating = Array.isArray(info.audits)
    ? info.audits.map((x) => String(x.watchGradeNm || "")).find(Boolean) || ""
    : "";
  const companies = Array.isArray(info.companys) ? info.companys : [];
  const companyNames = (role) => [...new Set(companies
    .filter((x) => String(x.companyPartNm || "").includes(role))
    .map((x) => String(x.companyNm || "").trim())
    .filter(Boolean))].slice(0, 3);

  return {
    genres,
    runtime: Number(info.showTm) || null,
    directors,
    cast,
    rating,
    producers: companyNames("제작"),
    distributors: companyNames("배급"),
    titleEn: String(info.movieNmEn || ""),
    titleOriginal: String(info.movieNmOg || ""),
  };
}


const movies = await loadPrev();
const archive = await loadPrev(ARCHIVE);
const before = movies.size;
const fetched = [];

for (let back = 1; back <= DAYS; back += 1) {
  const targetDt = kstDateBefore(back);
  const list = await fetchDay(targetDt);
  if (!list) {
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

const seen = new Map();
for (const { targetDt, list } of fetched) {
  for (const m of list) {
    const movieCd = String(m.movieCd);
    let e = seen.get(movieCd);
    if (!e) seen.set(movieCd, (e = { dates: new Set(), top: 99, row: null, rowDt: "" }));
    e.dates.add(targetDt);
    e.top = Math.min(e.top, Number(m.rank));
    if (targetDt === latestDt) {
      e.rankNow = Number(m.rank);
      e.dayNow = Number(m.audiCnt) || null;
    }
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
  const prev = movies.get(movieCd) || archive.get(movieCd);
  if (prev && archive.has(movieCd)) {
    archive.delete(movieCd);
    movies.set(movieCd, prev);
  }

  if (!prev) {
    movies.set(movieCd, {
      movieCd,
      title: String(m.movieNm),
      titleEn: "",
      titleOriginal: "",
      openedAt: m.openDt || "",
      audienceAcc: m.audiAcc ? Number(m.audiAcc) : null,
      genres: [],
      type: "영화",
      firstSeenAt: first,
      lastSeenAt: last,
      days: dates.length,
      bestRank: e.top,
      rank: e.rankNow ?? null,
      audienceDay: e.dayNow ?? null,
      runtime: null,
      directors: [],
      cast: [],
      producers: [],
      distributors: [],
      rating: "",
      koficDetailFetched: false,
      koficDetailVersion: 0,
    });
    continue;
  }

  const fresh = dates.filter((d) => d < prev.firstSeenAt || d > prev.lastSeenAt);
  prev.days += fresh.length;
  if (first < prev.firstSeenAt) prev.firstSeenAt = first;
  if (last > prev.lastSeenAt) prev.lastSeenAt = last;
  prev.bestRank = Math.min(prev.bestRank, e.top);
  prev.rank = e.rankNow ?? null;
  prev.audienceDay = e.dayNow ?? null;
  prev.title = String(m.movieNm);
  prev.openedAt = m.openDt || prev.openedAt;
  prev.audienceAcc = m.audiAcc ? Number(m.audiAcc) : prev.audienceAcc;
}


let dropped = 0;
for (const [movieCd, m] of movies) {
  if (daysBetween(latestDt, m.lastSeenAt) > KEEP_DAYS) {
    movies.delete(movieCd);
    m.rank = null;
    m.audienceDay = null;
    m.showing = false;
    archive.set(movieCd, m);
    dropped += 1;
  }
}


const KOFIC_DETAIL_VERSION = 3;
const needDetails = [...movies.values()].filter(
  (m) =>
    !m.koficDetailFetched ||
    !m.genres.length ||
    Number(m.koficDetailVersion || 0) < KOFIC_DETAIL_VERSION,
);
const DETAIL_BUDGET_MS = 6 * 60 * 1000;
const detailStart = Date.now();
let failed = 0;
let skipped = 0;
for (const m of needDetails) {
  if (Date.now() - detailStart > DETAIL_BUDGET_MS) {
    skipped += 1;
    continue;
  }
  try {
    const detail = await fetchMovieDetails(m.movieCd);
    if (detail.genres.length) m.genres = detail.genres;
    m.runtime = detail.runtime;
    m.directors = detail.directors;
    m.cast = detail.cast;
    m.producers = detail.producers;
    m.distributors = detail.distributors;
    m.rating = detail.rating;
    m.titleEn = detail.titleEn || m.titleEn || "";
    m.titleOriginal = detail.titleOriginal || m.titleOriginal || "";
    m.koficDetailFetched = true;
    m.koficDetailVersion = KOFIC_DETAIL_VERSION;
    m.type = "영화";
  } catch (e) {
    failed += 1;
    console.warn(`  상세 조회 실패 — ${m.title}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 200));
}
if (failed) {
  console.warn(`상세 조회 ${failed}/${needDetails.length}건 실패 — 다음 실행에서 다시 시도합니다.`);
}
if (skipped) {
  console.warn(
    `시간이 차서 ${skipped}/${needDetails.length}건은 상세 조회를 미뤘습니다. ` +
      "다음 실행에서 이어서 채웁니다.",
  );
}


const sorted = [...movies.values()].sort(
  (a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt) ||
    a.bestRank - b.bestRank ||
    a.title.localeCompare(b.title, "ko"),
);

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

const archived = [...archive.values()].sort(
  (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.title.localeCompare(b.title, "ko"),
);
let prevArchived = null;
try {
  prevArchived = JSON.stringify(JSON.parse(await readFile(ARCHIVE, "utf8")).movies);
} catch {}
if (prevArchived !== JSON.stringify(archived)) {
  await writeFile(ARCHIVE, JSON.stringify({
    note: "박스오피스 목록에서 내려간 영화의 상세 정보를 보존합니다.",
    source: "영화진흥위원회 오픈API 일별 박스오피스",
    movies: archived,
  }, null, 2) + "\n");
  console.log(`${ARCHIVE} 갱신: ${archived.length}편`);
}
