/**
 * 영화진흥위원회(KOFIC) 오픈API 에서 일별 박스오피스를 받아
 * assets/boxoffice.json 으로 저장합니다.
 *
 * 실행: KOFIC_API_KEY=... node scripts/fetch-boxoffice.mjs
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

/** 장르에 이 값이 있으면 애니 탭으로 분류합니다. */
const ANIMATION_GENRE = "애니메이션";

if (!KEY) {
  console.error("KOFIC_API_KEY 가 없습니다. 저장소 Secrets 에 등록하세요.");
  process.exit(1);
}

/** KOFIC 는 전날 집계를 제공합니다. 집계 기준이 한국 시간이라 KST 로 환산해 셉니다. */
function kstDateBefore(days) {
  const t = Date.now() + 9 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

function fail(msg, got) {
  console.error("KOFIC 응답이 예상과 다릅니다:", msg);
  if (got !== undefined) {
    console.error("받은 구조:", JSON.stringify(got, null, 2).slice(0, 1200));
  }
  console.error("\n기존 " + OUT + " 은 그대로 두었습니다.");
  process.exit(1);
}

/** 하루치를 조회합니다. 아직 집계 전이면 빈 목록이 오므로 null 을 돌려줍니다. */
async function fetchDay(targetDt) {
  const url = `${ENDPOINT}?key=${encodeURIComponent(KEY)}&targetDt=${targetDt}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
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

// 집계가 아직 안 올라온 시각에 돌 수 있으므로 하루 더 거슬러 시도합니다.
let targetDt = kstDateBefore(1);
let list = await fetchDay(targetDt);
if (!list) {
  targetDt = kstDateBefore(2);
  console.log(`전날(${kstDateBefore(1)}) 집계가 아직 없어 ${targetDt} 로 재시도합니다.`);
  list = await fetchDay(targetDt);
}
if (!list) fail(`최근 2일간 집계가 비어 있습니다 (${kstDateBefore(1)}, ${targetDt})`);

const REQUIRED = ["rank", "movieCd", "movieNm"];
const missing = REQUIRED.filter((f) => !(f in list[0]));
if (missing.length) fail("항목에 " + missing.join(", ") + " 필드가 없음", list[0]);

const movies = list.map((m) => ({
  rank: Number(m.rank),
  movieCd: String(m.movieCd),
  title: String(m.movieNm),
  openedAt: m.openDt || "",
  audienceAcc: m.audiAcc ? Number(m.audiAcc) : null,
}));

/**
 * 작품 상세에서 장르를 받아 옵니다.
 * 이 호출은 보조 정보라, 실패해도 그 작품만 장르 없이 두고 넘어갑니다.
 * 목록 자체가 날아가는 편보다 장르 한 칸이 비는 편이 낫기 때문입니다.
 */
async function fetchGenres(movieCd) {
  const url = `${DETAIL_ENDPOINT}?key=${encodeURIComponent(KEY)}&movieCd=${encodeURIComponent(movieCd)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.faultInfo) throw new Error(body.faultInfo.message || "faultInfo");
  const genres = body?.movieInfoResult?.movieInfo?.genres;
  if (!Array.isArray(genres)) throw new Error("movieInfoResult.movieInfo.genres 없음");
  return genres.map((g) => String(g.genreNm || "")).filter(Boolean);
}

let failed = 0;
for (const m of movies) {
  try {
    const genres = await fetchGenres(m.movieCd);
    m.genres = genres;
    m.type = genres.includes(ANIMATION_GENRE) ? "애니" : "영화";
  } catch (e) {
    failed += 1;
    console.warn(`  장르 조회 실패 — ${m.title}: ${e.message}`);
    m.genres = [];
    m.type = "영화"; // 확인 전까지는 애니로 분류하지 않습니다.
  }
  await new Promise((r) => setTimeout(r, 200)); // 연속 호출 간격
}
if (failed) {
  console.warn(`장르 조회 ${failed}/${movies.length}건 실패 — 해당 작품은 영화로 둡니다.`);
}

const out = {
  note: "현재 화면에는 표시하지 않습니다. 수집만 계속해 두는 데이터입니다.",
  source: "영화진흥위원회 오픈API 일별 박스오피스",
  sourceUrl: "https://www.kobis.or.kr/kobisopenapi/",
  targetDt,
  fetchedAt: new Date().toISOString().slice(0, 10),
  movies,
};

// 내용이 같으면 커밋이 생기지 않도록 그대로 둡니다.
const next = JSON.stringify(out, null, 2) + "\n";
let prev = "";
try {
  prev = await readFile(OUT, "utf8");
} catch {}
const same =
  prev &&
  JSON.stringify(JSON.parse(prev).movies) === JSON.stringify(out.movies);

if (same) {
  console.log("순위 변동 없음 — 파일을 그대로 둡니다.");
} else {
  await writeFile(OUT, next);
  console.log(`${OUT} 갱신: ${movies.length}편 (기준일 ${targetDt})`);
  movies
    .slice(0, 5)
    .forEach((m) =>
      console.log(`  ${m.rank}. ${m.title} [${m.type}] ${m.genres.join("·")}`),
    );
  const anime = movies.filter((m) => m.type === "애니");
  if (anime.length) {
    console.log(`  애니로 분류: ${anime.map((m) => m.title).join(", ")}`);
  }
}
