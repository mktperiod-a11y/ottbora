/**
 * 지금 방영 중인 화제작을 받아 assets/anime.json 에 씁니다.
 *
 * 실행: node scripts/fetch-anime.mjs
 *
 * 받아오는 곳이 둘입니다. 둘 다 키가 필요 없습니다.
 *
 *   1. AniList (graphql.anilist.co)  — 먼저 씁니다
 *   2. MyAnimeList (api.jikan.moe)   — AniList 가 안 되면
 *
 * 원래 Jikan 하나만 썼는데 실제 실행에서 계속 HTTP 504 였습니다.
 * /seasons/now 가 무거워서 그런 줄 알고 /top/anime 로 바꿔 봤지만
 * 그쪽도 같은 504 였습니다. 즉 특정 엔드포인트가 아니라 Jikan 자체가
 * GitHub 러너에서 열리지 않습니다.
 *
 *   2026-09-22 06:34  top/anime 504 ×3 → seasons/now 504 ×3 → 포기
 *
 * AniList 는 공식 GraphQL API 이고 키가 없어도 열립니다. 받아온
 * 값은 Jikan 모양으로 바꿔서 아래 코드가 출처를 몰라도 되게 합니다.
 * AniList 항목에 MAL 번호가 같이 오므로 링크는 계속 MAL 로 겁니다.
 *
 * "인기"의 기준은 members(이 작품을 목록에 넣은 사람 수)입니다.
 * 분기 초에는 평점 표본이 적어 상위가 흔들리는데, members 는 그보다
 * 안정적이고 "얼마나 화제인가"에 더 가깝습니다. 평점은 함께 적어만 둡니다.
 *
 * 한국어 제목은 Jikan 이 주지 않습니다. TMDB 키가 있으면 거기서 찾아
 * 채우고, 없으면 영어 제목을 씁니다. 키가 들어오면 다음 실행에서 메워집니다.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { savePoster, getJson, postJson, norm } from "./lib/poster.mjs";

const OUT = "assets/anime.json";
const DIR = "assets/posters";
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";
const TMDB = process.env.TMDB_API_KEY;
const TMDB_SEARCH = "https://api.themoviedb.org/3/search/tv";

/** 화면에 보여 줄 편수. */
const KEEP = 20;

/**
 * 목록에 넣은 사람이 이보다 적으면 뺍니다.
 * 분기 초에 몇십 명이 평점 10점을 준 작품이 1위로 올라오는 것을 막습니다.
 */
const MIN_MEMBERS = 3000;

/** Jikan 은 초당 3회 정도로 제한합니다. 넉넉하게 띄웁니다. */
const GAP_MS = 400;

/** 이런 등급·장르는 싣지 않습니다. */
const BLOCKED_GENRES = new Set(["Hentai", "Erotica", "Ecchi"]);
const BLOCKED_RATINGS = new Set(["Rx - Hentai", "R+ - Mild Nudity"]);

/** MAL 장르는 영어로 옵니다. 자주 나오는 것만 옮깁니다. */
const GENRE_KO = {
  /* AniList 에만 있는 이름 */
  Psychological: "심리",
  Thriller: "스릴러",
  Music: "음악",
  Mecha: "메카",
  /* 두 곳에 공통 */
  Action: "액션",
  Adventure: "어드벤처",
  "Avant Garde": "실험적",
  "Award Winning": "수상작",
  "Boys Love": "BL",
  Comedy: "코미디",
  Drama: "드라마",
  Fantasy: "판타지",
  "Girls Love": "GL",
  Gourmet: "음식",
  Horror: "공포",
  Mystery: "미스터리",
  Romance: "로맨스",
  "Sci-Fi": "SF",
  "Slice of Life": "일상",
  Sports: "스포츠",
  Supernatural: "초자연",
  Suspense: "서스펜스",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 애니를 받지 못하고 끝냅니다.
 *
 * 0 으로 끝냅니다. 이 단계가 잡을 죽이면 같은 실행에서 이미 성공한
 * 박스오피스·포스터 작업까지 커밋되지 않고 버려집니다. 실제로 그런 일이
 * 있었습니다 — Jikan 이 504 를 주는 사이 포스터 40장이 함께 날아갔습니다.
 *
 * 애니는 다른 데이터에 얹히는 부가 작업이고, Jikan 은 무료 커뮤니티 API 라
 * 간헐적으로 응답하지 않습니다. 못 받으면 기존 파일을 두고 다음 실행에
 * 맡기는 편이 맞습니다.
 */
function giveUp(msg, got) {
  console.warn("");
  console.warn("─".repeat(60));
  console.warn("애니 갱신을 건너뜁니다:", msg);
  if (got !== undefined) {
    console.warn("받은 구조:", JSON.stringify(got, null, 2).slice(0, 1200));
  }
  console.warn(`기존 ${OUT} 은 그대로 두고, 다음 실행에서 다시 시도합니다.`);
  console.warn("─".repeat(60));
  process.exit(0);
}

// ---- 1. 이번 분기 목록 받기 -----------------------------------------------

/**
 * 한 페이지에 25편씩 옵니다. 상위 20편을 고르려면 후보를 넉넉히 봐야
 * members 순으로 줄 세울 수 있으므로 몇 페이지를 이어 받습니다.
 */
const PAGES = 3;

/*
 * AniList 에서 받아옵니다.
 *
 * status: RELEASING  = 지금 방영 중
 * sort: POPULARITY_DESC = 목록에 넣은 사람 수 순 (MAL 의 members 와 같은 뜻)
 * isAdult: false     = 성인물 제외
 */
const ANILIST_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      coverImage { extraLarge large }
      popularity
      averageScore
      episodes
      genres
      season
      seasonYear
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

/*
 * AniList 응답을 Jikan 모양으로 바꿉니다.
 * 아래 코드가 어느 출처에서 왔는지 몰라도 되게 하려는 것입니다.
 */
function fromAniList(m) {
  const url = m.coverImage?.extraLarge || m.coverImage?.large || "";
  return {
    mal_id: m.idMal || `al-${m.id}`,
    title: m.title?.english || m.title?.romaji || "",
    title_english: m.title?.english || "",
    title_japanese: m.title?.native || "",
    images: { jpg: { large_image_url: url, image_url: url } },
    // AniList 의 popularity = 목록에 넣은 사람 수. MAL 의 members 와 같습니다.
    members: m.popularity ?? null,
    // AniList 평점은 100점 만점이라 10점 만점으로 맞춥니다.
    score: m.averageScore != null ? Number((m.averageScore / 10).toFixed(2)) : null,
    episodes: m.episodes ?? null,
    genres: (m.genres || []).map((name) => ({ name })),
    studios: (m.studios?.nodes || []).map((x) => ({ name: x.name })),
    season: m.season ? m.season.toLowerCase() : "",
    year: m.seasonYear ?? null,
    rating: "",
    // MAL 번호가 있을 때만 MAL 링크를 겁니다. 화면의 허용 호스트 목록이
    // myanimelist.net 뿐이라, 번호가 없으면 링크 없이 둡니다.
    url: m.idMal ? `https://myanimelist.net/anime/${m.idMal}` : "",
    posterReferer: "https://anilist.co/",
    provider: "AniList",
  };
}

async function fromAniListAll() {
  const out = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const body = await postJson(
      ANILIST,
      { query: ANILIST_QUERY, variables: { page, perPage: 25 } },
      `AniList ${page}쪽`,
      { attempts: 3, timeout: 20000, backoffMs: 3000 },
    );
    const media = body?.data?.Page?.media;
    if (!Array.isArray(media)) throw new Error(`${page}쪽의 media 가 배열이 아님`);
    out.push(...media.map(fromAniList));
    if (!body.data.Page.pageInfo?.hasNextPage) break;
    await sleep(GAP_MS);
  }
  return out;
}

async function fromJikanAll() {
  const out = [];
  for (let page = 1; page <= PAGES; page += 1) {
    let body;
    try {
      body = await getJson(
        `${JIKAN}/top/anime?filter=airing&limit=25&sfw=true&page=${page}`,
        `Jikan ${page}쪽`,
        { attempts: 3, timeout: 20000, backoffMs: 4000 },
      );
    } catch (e) {
      if (page === 1) throw e;
      console.warn(`  ${page}쪽을 받지 못해 여기까지로 마칩니다: ${e.message}`);
      break;
    }
    if (!Array.isArray(body?.data)) {
      throw new Error(`${page}쪽의 data 가 배열이 아님`);
    }
    out.push(
      ...body.data.map((a) => ({
        ...a,
        posterReferer: "https://myanimelist.net/",
        provider: "MyAnimeList",
      })),
    );
    if (!body.pagination?.has_next_page) break;
    await sleep(GAP_MS);
  }
  return out;
}

const SOURCES = [
  { name: "AniList", get: fromAniListAll },
  { name: "MyAnimeList(Jikan)", get: fromJikanAll },
];

let raw = [];
let usedSource = "";
const failures = [];
for (const source of SOURCES) {
  try {
    raw = await source.get();
    if (raw.length) {
      usedSource = source.name;
      console.log(`${source.name} 에서 ${raw.length}편을 받았습니다.`);
      break;
    }
    failures.push(`${source.name}: 빈 목록`);
  } catch (e) {
    failures.push(`${source.name}: ${e.message}`);
    console.warn(`  ${source.name} 실패 — 다음 출처로 넘어갑니다: ${e.message}`);
  }
}

if (!raw.length) {
  giveUp(
    "어느 출처에서도 목록을 받지 못했습니다 (" +
      failures.join(" / ") +
      "). 일시적인 장애일 수 있으니 잠시 뒤 다시 실행해 보세요.",
  );
}

const REQUIRED = ["mal_id", "title", "images"];
const missing = REQUIRED.filter((f) => !(f in raw[0]));
if (missing.length) giveUp("항목에 " + missing.join(", ") + " 가 없음", raw[0]);



// ---- 2. 고르고 줄 세우기 ---------------------------------------------------

const picked = raw
  .filter((a) => {
    const genres = (a.genres || []).map((g) => g.name);
    if (genres.some((g) => BLOCKED_GENRES.has(g))) return false;
    if (BLOCKED_RATINGS.has(a.rating)) return false;
    if (!a.images?.jpg?.large_image_url && !a.images?.jpg?.image_url) return false;
    return (a.members || 0) >= MIN_MEMBERS;
  })
  // members = 이 작품을 목록에 넣은 사람 수. 화제성에 가장 가까운 값입니다.
  .sort((a, b) => (b.members || 0) - (a.members || 0))
  .slice(0, KEEP);

console.log(
  `조건을 통과한 ${picked.length}편을 싣습니다 ` +
    `(목록 등록 ${MIN_MEMBERS}명 이상, 성인 등급 제외).`,
);

// ---- 3. 한국어 제목 (TMDB 키가 있을 때만) ----------------------------------

/**
 * Jikan 은 한국어 제목을 주지 않습니다. TMDB 의 TV 검색으로 찾습니다.
 * 원제(일본어)로 찾으면 가장 잘 맞고, 안 되면 영어 제목으로 다시 봅니다.
 */
async function koreanTitle(a) {
  if (!TMDB) return null;
  for (const q of [a.title_japanese, a.title_english, a.title].filter(Boolean)) {
    try {
      const body = await getJson(
        `${TMDB_SEARCH}?${new URLSearchParams({
          api_key: TMDB,
          query: q,
          language: "ko-KR",
        })}`,
        `TMDB ${q}`,
      );
      const hits = body?.results;
      if (!Array.isArray(hits)) continue;
      // 원어 제목이 맞는 것만 씁니다. 엉뚱한 작품 제목이 붙으면 안 됩니다.
      const want = [a.title_japanese, a.title_english, a.title]
        .filter(Boolean)
        .map(norm);
      const hit = hits.find(
        (r) =>
          want.includes(norm(r.original_name)) || want.includes(norm(r.name)),
      );
      // 한국어가 아니면(한글이 없으면) 쓰지 않습니다.
      if (hit?.name && /[가-힣]/.test(hit.name)) return hit.name;
    } catch {
      // 보조 정보라 실패해도 넘어갑니다.
    }
    await sleep(GAP_MS);
  }
  return null;
}

// ---- 4. 포스터 받고 저장 ---------------------------------------------------

await mkdir(DIR, { recursive: true });

let prev = [];
try {
  prev = JSON.parse(await readFile(OUT, "utf8")).works || [];
} catch {}
const prevById = new Map(prev.map((w) => [w.malId, w]));

const works = [];
let got = 0, kept = 0, failed = 0;

for (const a of picked) {
  const file = `${DIR}/anime-${a.mal_id}.webp`;
  const old = prevById.get(a.mal_id);

  // 이미 받아 둔 포스터는 다시 받지 않습니다.
  let poster = old?.poster && existsSync(file) ? old.poster : null;
  if (poster) kept += 1;
  else {
    const url = a.images.jpg.large_image_url || a.images.jpg.image_url;
    try {
      const size = await savePoster(
        url,
        file,
        a.posterReferer || "https://myanimelist.net/",
      );
      poster = file;
      got += 1;
      console.log(`  ${a.title} (${Math.round(size / 1024)}KB)`);
    } catch (e) {
      failed += 1;
      console.warn(`  포스터 실패 — ${a.title}: ${e.message}`);
    }
    await sleep(GAP_MS);
  }

  const genres = (a.genres || [])
    .map((g) => GENRE_KO[g.name] || g.name)
    .filter(Boolean);

  // 이미 찾아 둔 한국어 제목은 다시 찾지 않습니다.
  const ko = old?.titleKo || (await koreanTitle(a));

  works.push({
    malId: a.mal_id,
    // 한국어 제목이 있으면 그것을, 없으면 영어 제목을 씁니다.
    title: ko || a.title_english || a.title,
    ...(ko ? { titleKo: ko } : {}),
    titleOriginal: a.title,
    genres,
    episodes: a.episodes ?? null,
    score: a.score ?? null,
    members: a.members ?? null,
    studio: (a.studios || [])[0]?.name || "",
    season: a.season && a.year ? `${a.year} ${a.season}` : "",
    poster,
    posterCredit: a.provider || "MyAnimeList",
    // 출처가 둘이라 화면이 "MAL 평점" 이라고 못 박으면 안 됩니다.
    scoreBy: a.provider || "MyAnimeList",
    malUrl: a.url ?? `https://myanimelist.net/anime/${a.mal_id}`,
  });
}

const SOURCE_INFO = {
  AniList: { label: "AniList", url: "https://anilist.co/" },
  "MyAnimeList(Jikan)": { label: "MyAnimeList · Jikan API", url: "https://jikan.moe/" },
};
const info = SOURCE_INFO[usedSource] || SOURCE_INFO.AniList;

const out = {
  note: "지금 방영 중인 화제작입니다. 콘텐츠ZONE 의 애니 탭에서 씁니다.",
  source: info.label,
  sourceUrl: info.url,
  rankedBy: "목록에 넣은 사람 수 순",
  // 받은 작품들이 공통으로 가리키는 분기입니다.
  season: picked[0]?.season && picked[0]?.year
    ? `${picked[0].year} ${picked[0].season}`
    : "",
  updatedAt: new Date().toISOString().slice(0, 10),
  koreanTitles: TMDB ? "TMDB 에서 조회" : "TMDB 키가 없어 영어 제목을 씁니다",
  works,
};

const next = JSON.stringify(out, null, 2) + "\n";
let same = false;
try {
  const before = JSON.parse(await readFile(OUT, "utf8"));
  same = JSON.stringify(before.works) === JSON.stringify(out.works);
} catch {}

if (same) {
  console.log("\n변동 없음 — 파일을 그대로 둡니다.");
} else {
  await writeFile(OUT, next);
  const koCount = works.filter((w) => w.titleKo).length;
  console.log(
    `\n${OUT} 갱신: ${works.length}편 ` +
      `(포스터 새로 ${got}편 · 유지 ${kept}편 · 실패 ${failed}편, 한국어 제목 ${koCount}편)`,
  );
  if (!TMDB) {
    console.log("TMDB_API_KEY 를 등록하면 다음 실행에서 한국어 제목을 채웁니다.");
  }
}
