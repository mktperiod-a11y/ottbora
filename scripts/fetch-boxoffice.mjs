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

if (!KEY) {
  console.error("KOFIC_API_KEY 가 없습니다. 저장소 Secrets 에 등록하세요.");
  process.exit(1);
}

/** KOFIC 는 전날 집계를 제공하므로 어제 날짜를 조회합니다. */
function targetDate() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000); // 집계 기준이 한국 시간
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function fail(msg, got) {
  console.error("KOFIC 응답이 예상과 다릅니다:", msg);
  if (got !== undefined) {
    console.error("받은 구조:", JSON.stringify(got, null, 2).slice(0, 1200));
  }
  console.error("\n기존 " + OUT + " 은 그대로 두었습니다.");
  process.exit(1);
}

const targetDt = targetDate();
const url = `${ENDPOINT}?key=${encodeURIComponent(KEY)}&targetDt=${targetDt}`;

const res = await fetch(url, { headers: { accept: "application/json" } });
if (!res.ok) fail(`HTTP ${res.status}`);

let body;
try {
  body = await res.json();
} catch {
  fail("JSON 이 아닙니다 (키가 잘못됐을 때 HTML 오류 페이지가 옵니다)");
}

if (body?.faultInfo) fail(body.faultInfo.message || "faultInfo 반환", body.faultInfo);

const list = body?.boxOfficeResult?.dailyBoxOfficeList;
if (!Array.isArray(list)) fail("boxOfficeResult.dailyBoxOfficeList 가 배열이 아님", body);
if (!list.length) fail("목록이 비어 있음 (targetDt=" + targetDt + ")", body);

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

const out = {
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
  movies.slice(0, 5).forEach((m) => console.log(`  ${m.rank}. ${m.title}`));
}
