/**
 * TMDB에서 최근 한국 TV 프로그램을 받아 드라마/예능 후보를 자동 분류합니다.
 *
 * 출력: assets/tv-ranking.json
 * - 드라마: TMDB Drama 장르 중심
 * - 예능: Reality/Talk + 한국형 키워드 + whitelist/blacklist
 * - 순위: 각 분류 안에서 TMDB popularity 내림차순
 * - 저장 상한: 드라마 60편 + 예능 60편
 * - 종영작 보정: TV 상세 status/last_air_date/next_episode_to_air 확인
 * - 한국 제공처: TV 상세 watch/providers의 KR flatrate/free/ads 저장
 *
 * 외부 API가 실패하면 기존 파일을 보존하고 exit 0 합니다.
 * 기존 파일이 없으면 수동 content-data.json이 프론트 fallback 역할을 합니다.
 */

import { readFile, writeFile } from "node:fs/promises";
import { getJson } from "./lib/poster.mjs";

const OUT = "assets/tv-ranking.json";
const RULES = "assets/tv-ranking-rules.json";
const TMDB = process.env.TMDB_API_KEY;
const DISCOVER = "https://api.themoviedb.org/3/discover/tv";
const TV_DETAIL = "https://api.themoviedb.org/3/tv";
const KEEP_PER_TYPE = 60;
const CANDIDATE_PER_TYPE = 90;
const PAGES = 10;
const LOOKBACK_DAYS = 35;
const ACTIVE_GRACE_DAYS = 210;
const DETAIL_GAP_MS = 100;

const GENRE = {
  ANIMATION: 16,
  COMEDY: 35,
  DRAMA: 18,
  DOCUMENTARY: 99,
  KIDS: 10762,
  NEWS: 10763,
  REALITY: 10764,
  TALK: 10767,
};

function giveUp(msg) {
  console.warn("TV 자동 갱신 건너뜀:", msg);
  console.warn(`기존 ${OUT}이 있으면 그대로 사용합니다.`);
  process.exit(0);
}

if (!TMDB) giveUp("TMDB_API_KEY가 없습니다.");

let rules = {
  whitelistVarietyIds: [],
  blacklistVarietyIds: [],
  includeKeywords: [],
  excludeKeywords: [],
};
try {
  rules = { ...rules, ...JSON.parse(await readFile(RULES, "utf8")) };
} catch {}

const white = new Set(rules.whitelistVarietyIds || []);
const black = new Set(rules.blacklistVarietyIds || []);
const includes = (rules.includeKeywords || []).map((x) => String(x).toLowerCase());
const excludes = (rules.excludeKeywords || []).map((x) => String(x).toLowerCase());

const today = new Date();
const from = new Date(today.getTime() - LOOKBACK_DAYS * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dateWithin(raw, days) {
  const m = String(raw || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const age = (now - then) / 86400000;
  return age >= 0 && age <= days;
}

const raw = [];
for (let page = 1; page <= PAGES; page += 1) {
  try {
    const qs = new URLSearchParams({
      api_key: TMDB,
      language: "ko-KR",
      with_origin_country: "KR",
      with_original_language: "ko",
      sort_by: "popularity.desc",
      "air_date.gte": iso(from),
      "air_date.lte": iso(today),
      include_null_first_air_dates: "false",
      page: String(page),
    });
    const body = await getJson(`${DISCOVER}?${qs}`, `TMDB 한국 TV ${page}쪽`, {
      attempts: 3,
      timeout: 15000,
      backoffMs: 3000,
    });
    if (!Array.isArray(body?.results)) giveUp("TMDB results가 배열이 아닙니다.");
    raw.push(...body.results);
    if (page >= (body.total_pages || page)) break;
  } catch (e) {
    if (!raw.length) giveUp(e.message);
    console.warn(`${page}쪽 실패 — 앞에서 받은 데이터만 사용: ${e.message}`);
    break;
  }
}

const uniq = [...new Map(raw.map((x) => [x.id, x])).values()];

// whitelist는 단순 분류 보정이 아니라 Discover 후보에서 빠진 작품도
// 강제로 후보군에 주입합니다. 수동 큐레이션으로 현재작임을 확인한 경우에만 씁니다.
for (const id of white) {
  if (uniq.some((x) => x.id === id)) continue;
  try {
    const qs = new URLSearchParams({
      api_key: TMDB,
      language: "ko-KR",
      append_to_response: "watch/providers",
    });
    const detail = await getJson(
      `${TV_DETAIL}/${id}?${qs}`,
      `TMDB whitelist 상세 ${id}`,
      { attempts: 2, timeout: 10000, backoffMs: 1000 },
    );
    uniq.push({
      ...detail,
      genre_ids: (detail.genres || []).map((g) => g.id),
    });
  } catch (e) {
    console.warn(`  whitelist 주입 실패 — ${id}: ${e.message}`);
  }
  await sleep(DETAIL_GAP_MS);
}

function textOf(x) {
  return `${x.name || ""} ${x.original_name || ""} ${x.overview || ""}`.toLowerCase();
}
function hasAny(text, words) {
  return words.some((w) => text.includes(w));
}
function blocked(x) {
  const ids = new Set(x.genre_ids || []);
  const text = textOf(x);
  return (
    ids.has(GENRE.NEWS) ||
    ids.has(GENRE.DOCUMENTARY) ||
    ids.has(GENRE.KIDS) ||
    ids.has(GENRE.ANIMATION) ||
    hasAny(text, excludes)
  );
}
function isVariety(x) {
  if (black.has(x.id)) return false;
  if (white.has(x.id)) return true;
  if (blocked(x)) return false;
  const ids = new Set(x.genre_ids || []);
  if (ids.has(GENRE.REALITY) || ids.has(GENRE.TALK)) return true;
  return hasAny(textOf(x), includes);
}
function isDrama(x) {
  if (blocked(x) || isVariety(x)) return false;
  return new Set(x.genre_ids || []).has(GENRE.DRAMA);
}
function mapWork(x, type, rank) {
  const kr = x["watch/providers"]?.results?.KR || {};
  const providers = [
    ...(Array.isArray(kr.flatrate) ? kr.flatrate : []),
    ...(Array.isArray(kr.free) ? kr.free : []),
    ...(Array.isArray(kr.ads) ? kr.ads : []),
  ]
    .map((p) => p.provider_name)
    .filter(Boolean)
    .filter((name, i, arr) => arr.indexOf(name) === i);

  return {
    tmdbId: x.id,
    title: x.name || x.original_name,
    originalTitle: x.original_name || "",
    type,
    rank,
    popularity: x.popularity ?? null,
    genres: x.genre_ids || [],
    overview: x.overview || "",
    firstAirDate: x.first_air_date || "",
    lastAirDate: x.last_air_date || "",
    status: x.status || "",
    inProduction: Boolean(x.in_production),
    nextAirDate: x.next_episode_to_air?.air_date || "",
    providers,
    poster: x.poster_path
      ? `https://image.tmdb.org/t/p/w500${x.poster_path}`
      : null,
    posterCredit: "TMDB",
    rankingSource: {
      provider: "TMDB",
      metric: "popularity",
      rank,
      observedAt: iso(today),
    },
    metadataSource: "TMDB",
  };
}

const sorted = uniq.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
const varietyCandidates = sorted.filter(isVariety).slice(0, CANDIDATE_PER_TYPE);
const dramaCandidates = sorted.filter(isDrama).slice(0, CANDIDATE_PER_TYPE);

const detailTargets = [
  ...new Map(
    [...varietyCandidates, ...dramaCandidates].map((x) => [x.id, x]),
  ).values(),
];
const detailById = new Map();

for (const x of detailTargets) {
  try {
    const qs = new URLSearchParams({
      api_key: TMDB,
      language: "ko-KR",
    });
    const detail = await getJson(
      `${TV_DETAIL}/${x.id}?${qs}`,
      `TMDB TV 상세 ${x.id}`,
      { attempts: 2, timeout: 10000, backoffMs: 1000 },
    );
    detailById.set(x.id, detail);
  } catch (e) {
    // 상세 조회가 잠깐 실패했다고 정상 후보를 버리지는 않습니다.
    detailById.set(x.id, { detailUnavailable: true });
    console.warn(`  상세 확인 실패 — ${x.name || x.id}: ${e.message}`);
  }
  await sleep(DETAIL_GAP_MS);
}

function withDetail(x) {
  return { ...x, ...(detailById.get(x.id) || {}) };
}

function currentlyRelevant(x) {
  if (white.has(x.id)) return true;
  if (x.detailUnavailable) return true;
  if (x.next_episode_to_air) return true;
  if (dateWithin(x.last_air_date, LOOKBACK_DAYS)) return true;

  // TMDB의 Returning Series / in_production 값은 오래된 웹예능에도
  // 남아 있는 경우가 있어 이것만으로는 "현재성"을 보장하지 않습니다.
  // 다음 방송일이 없으면 최근 방영 기록이 일정 기간 안에 있어야 유지합니다.
  const activeStatus =
    x.in_production ||
    ["Returning Series", "In Production", "Planned", "Pilot"].includes(x.status);
  return activeStatus && dateWithin(x.last_air_date, ACTIVE_GRACE_DAYS);
}

const varietyRaw = varietyCandidates
  .map(withDetail)
  .filter(currentlyRelevant)
  .slice(0, KEEP_PER_TYPE);
const dramaRaw = dramaCandidates
  .map(withDetail)
  .filter(currentlyRelevant)
  .slice(0, KEEP_PER_TYPE);

const variety = varietyRaw.map((x, i) => mapWork(x, "예능", i + 1));
const drama = dramaRaw.map((x, i) => mapWork(x, "드라마", i + 1));

if (!variety.length && !drama.length) giveUp("분류 결과가 모두 비었습니다.");

const out = {
  note: "TMDB 최근 한국 TV 후보를 한국형 예외 필터로 드라마/예능 분류한 자동 데이터입니다.",
  source: "TMDB",
  rankedBy: "TMDB popularity 순",
  updatedAt: iso(today),
  lookbackDays: LOOKBACK_DAYS,
  rules: {
    whitelistVarietyIds: [...white],
    blacklistVarietyIds: [...black],
  },
  drama,
  variety,
};

let same = false;
try {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  same =
    JSON.stringify(prev.drama) === JSON.stringify(out.drama) &&
    JSON.stringify(prev.variety) === JSON.stringify(out.variety);
} catch {}

if (same) {
  console.log(`변동 없음 — 드라마 ${drama.length}, 예능 ${variety.length}`);
} else {
  await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`${OUT} 갱신 — 드라마 ${drama.length}, 예능 ${variety.length}`);
}
