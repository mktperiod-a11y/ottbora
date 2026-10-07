
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { savePoster, getJson, postJson, norm } from "./lib/poster.mjs";
import {
  MODEL as TRANSLATE_MODEL,
  translateSynopsis,
  translateTitle,
  translatorReady,
  stopsTranslation,
  looksKorean,
} from "./lib/translate-synopsis.mjs";

const OUT = "assets/anime.json";
const TITLE_ALIASES = "assets/anime-title-aliases.json";
const TITLE_AUTO = "assets/anime-title-auto.json";
const SYNOPSIS_KO = "assets/anime-synopsis-ko.json";
const SYNOPSIS_AUTO = "assets/anime-synopsis-auto.json";

const MAX_TRANSLATIONS = 12;
const DIR = "assets/posters";
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";
const TMDB = process.env.TMDB_API_KEY;
const TMDB_SEARCH = "https://api.themoviedb.org/3/search/tv";

const KEEP = 20;

const MIN_MEMBERS = 3000;

const GAP_MS = 400;

const BLOCKED_GENRES = new Set(["Hentai", "Erotica", "Ecchi"]);
const BLOCKED_RATINGS = new Set(["Rx - Hentai", "R+ - Mild Nudity"]);

const GENRE_KO = {
  Psychological: "심리",
  Thriller: "스릴러",
  Music: "음악",
  Mecha: "메카",
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

let titleAliases = {};
try {
  titleAliases = JSON.parse(await readFile(TITLE_ALIASES, "utf8")).titles || {};
} catch {}

let titleCache = { translations: {} };
try {
  titleCache = JSON.parse(await readFile(TITLE_AUTO, "utf8"));
  titleCache.translations ||= {};
} catch {}
let titleChanged = false;
let titleLeft = MAX_TRANSLATIONS;

let synopsisKo = {};
try {
  synopsisKo = JSON.parse(await readFile(SYNOPSIS_KO, "utf8"));
} catch {}

let autoCache = { translations: {} };
try {
  autoCache = JSON.parse(await readFile(SYNOPSIS_AUTO, "utf8"));
  autoCache.translations ||= {};
} catch {}
let autoChanged = false;
let autoLeft = MAX_TRANSLATIONS;
let translatorOn = translatorReady();

async function autoTitle(a) {
  const key = String(a.mal_id);
  const title = a.title_english || a.title;
  const original = a.title_japanese || a.title;
  const source = createHash("sha1").update(`${title}\n${original}`).digest("hex").slice(0, 12);
  const saved = titleCache.translations[key];
  if (saved?.source === source && validTitle(saved.ko)) return saved.ko;
  if (!translatorOn || titleLeft <= 0) return "";

  titleLeft -= 1;
  try {
    const ko = (await translateTitle({ title, original })).trim();
    if (!validTitle(ko)) {
      console.warn(`  제목 번역 결과가 이상해 원문을 둡니다 — ${title}`);
      return "";
    }
    titleCache.translations[key] = { source, ko };
    titleChanged = true;
    console.log(`  제목 번역 — ${title} → ${ko}`);
    return ko;
  } catch (e) {
    console.warn(`  제목 번역 실패 — ${title}: ${e.message}`);
    if (stopsTranslation(e)) {
      translatorOn = false;
      console.warn("  이번 실행에서는 더 번역하지 않습니다(키 또는 요청 한도 문제).");
    }
    return "";
  }
}

function validTitle(title) {
  return typeof title === "string" && /[가-힣]/.test(title) &&
    title.length <= 110 && !/[\r\n<>]/.test(title) &&
    !/^["'“‘`]|["'”’`]$/.test(title);
}

async function autoTranslate(id, en, title, originalTitle) {
  const key = String(id);
  const source = createHash("sha1").update(en).digest("hex").slice(0, 12);
  const saved = autoCache.translations[key];
  if (saved?.source === source && saved.ko) return saved.ko;
  if (!translatorOn || autoLeft <= 0) return "";

  autoLeft -= 1;
  try {
    const ko = cleanSynopsis(
      await translateSynopsis({ text: en, title, original: originalTitle }),
    );
    if (!looksKorean(ko, en)) {
      console.warn(`  줄거리 번역 결과가 이상해 원문을 둡니다 — ${title}`);
      return "";
    }
    autoCache.translations[key] = { source, ko };
    autoChanged = true;
    console.log(`  줄거리 번역 — ${title} (원문 ${en.length}자 → ${ko.length}자)`);
    return ko;
  } catch (e) {
    console.warn(`  줄거리 번역 실패 — ${title}: ${e.message}`);
    if (stopsTranslation(e)) {
      translatorOn = false;
      console.warn("  이번 실행에서는 더 번역하지 않습니다(키 또는 요청 한도 문제).");
    }
    return "";
  }
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function cleanSynopsis(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/~![\s\S]*?!~/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(
      /<\/?(?:br|p|i|b|em|strong|u|s|small|span|a|div|font|sup|sub|hr|ul|ol|li|h[1-6]|blockquote)(?:\s+[a-z-]+=(?:"[^"]*"|'[^']*'|[^\s>]+))*\s*\/?>/gi,
      "",
    )
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    })
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\((?:Source|출처)\s*:[^)]*\)/gi, "")
    .replace(/\[Written by MAL Rewrite\]/gi, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => !/^(?:Notes?|Source)\s*:/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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


const PAGES = 3;

const ANILIST_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC, isAdult: false) {
      id
      idMal
      title { romaji english native }
      description(asHtml: false)
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

function fromAniList(m) {
  const url = m.coverImage?.extraLarge || m.coverImage?.large || "";
  return {
    mal_id: m.idMal || `al-${m.id}`,
    title: m.title?.english || m.title?.romaji || "",
    title_english: m.title?.english || "",
    title_japanese: m.title?.native || "",
    synopsis: m.description || "",
    images: { jpg: { large_image_url: url, image_url: url } },
    members: m.popularity ?? null,
    score: m.averageScore != null ? Number((m.averageScore / 10).toFixed(2)) : null,
    episodes: m.episodes ?? null,
    genres: (m.genres || []).map((name) => ({ name })),
    studios: (m.studios?.nodes || []).map((x) => ({ name: x.name })),
    season: m.season ? m.season.toLowerCase() : "",
    year: m.seasonYear ?? null,
    rating: "",
    url: m.idMal ? `https://myanimelist.net/anime/${m.idMal}` : "",
    posterReferer: "https://anilist.co/",
    provider: "AniList",
    anilistId: m.id,
  };
}

const THIN_SYNOPSIS =
  /^(?:the\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final|\d+(?:st|nd|rd|th))\s+(?:season|part|cour|half)\b|sequel\b)/i;

function isThinSynopsis(text) {
  const t = cleanSynopsis(text);
  return !t || (t.length < 160 && THIN_SYNOPSIS.test(t));
}

const PREQUEL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    relations { edges { relationType node { id type description(asHtml: false) } } }
  }
}`;

async function prequelSynopsis(anilistId) {
  let id = anilistId;
  for (let hop = 0; hop < 4 && id; hop += 1) {
    let body;
    try {
      body = await postJson(
        ANILIST,
        { query: PREQUEL_QUERY, variables: { id } },
        `AniList 이전 시즌 ${id}`,
        { attempts: 2, timeout: 15000, backoffMs: 2000 },
      );
    } catch {
      return "";
    }
    await sleep(GAP_MS);
    const edges = body?.data?.Media?.relations?.edges || [];
    const prev =
      edges.find((e) => e.relationType === "PREQUEL" && e.node?.type === "ANIME")?.node ||
      edges.find((e) => e.relationType === "PARENT" && e.node?.type === "ANIME")?.node;
    if (!prev) return "";
    if (!isThinSynopsis(prev.description)) return prev.description;
    id = prev.id;
  }
  return "";
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




const picked = raw
  .filter((a) => {
    const genres = (a.genres || []).map((g) => g.name);
    if (genres.some((g) => BLOCKED_GENRES.has(g))) return false;
    if (BLOCKED_RATINGS.has(a.rating)) return false;
    if (!a.images?.jpg?.large_image_url && !a.images?.jpg?.image_url) return false;
    return (a.members || 0) >= MIN_MEMBERS;
  })
  .sort((a, b) => (b.members || 0) - (a.members || 0))
  .slice(0, KEEP);

console.log(
  `조건을 통과한 ${picked.length}편을 싣습니다 ` +
    `(목록 등록 ${MIN_MEMBERS}명 이상, 성인 등급 제외).`,
);


const tmdbSearches = new Map();
async function searchTmdb(query, label) {
  if (tmdbSearches.has(query)) return tmdbSearches.get(query);
  let hits = null;
  try {
    const body = await getJson(
      `${TMDB_SEARCH}?${new URLSearchParams({
        api_key: TMDB,
        query,
        language: "ko-KR",
      })}`,
      label,
    );
    if (Array.isArray(body?.results)) hits = body.results;
  } catch {}
  tmdbSearches.set(query, hits);
  await sleep(GAP_MS);
  return hits;
}

function seasonBase(a) {
  const english = a.title_english || a.title || "";
  const m =
    english.match(/^(.*?)(?:\s+Season\s+(\d+))$/i) ||
    english.match(/^(.*?)(?:\s+([IVX]+))$/);
  if (!m) return null;

  const base = m[1].trim();
  let season = m[2];
  const roman = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  if (!/^\d+$/.test(season)) season = roman[season.toUpperCase()] || "";
  if (!base || !season) return null;
  return { base, season };
}

const TMDB_ANIMATION = 16;
const animated = (hits) =>
  (hits || []).filter((r) => (r.genre_ids || []).includes(TMDB_ANIMATION));

async function* tmdbMatches(a, state = {}) {
  if (!TMDB) return;

  const exactQueries = [a.title_japanese, a.title_english, a.title].filter(Boolean);
  const want = exactQueries.map(norm);
  for (const q of exactQueries) {
    const hits = await searchTmdb(q, `TMDB ${q}`);
    if (hits === null) state.failed = true;
    const hit = animated(hits).find(
      (r) => want.includes(norm(r.original_name)) || want.includes(norm(r.name)),
    );
    if (hit) yield { hit, season: "" };
  }

  const sb = seasonBase(a);
  if (!sb) return;
  const hits = await searchTmdb(sb.base, `TMDB base ${sb.base}`);
  if (hits === null) state.failed = true;
  const hit = animated(hits).find(
    (r) => norm(r.original_name) === norm(sb.base) || norm(r.name) === norm(sb.base),
  );
  if (hit) yield { hit, season: sb.season };
}

async function koreanTitle(a) {
  for await (const { hit, season } of tmdbMatches(a)) {
    if (!hit.name || !/[가-힣]/.test(hit.name)) continue;
    if (!season) return hit.name;
    return /\d+기$/.test(hit.name) ? hit.name : `${hit.name} ${season}기`;
  }
  return null;
}

async function koreanOverview(a) {
  const state = {};
  for await (const { hit } of tmdbMatches(a, state)) {
    if (/[가-힣]/.test(hit.overview || "")) return { text: hit.overview, failed: false };
  }
  return { text: "", failed: Boolean(state.failed) };
}


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

  const alias = titleAliases[String(a.mal_id)] || "";
  const ko = alias || old?.titleKo || (await koreanTitle(a)) || (await autoTitle(a));

  const translated = cleanSynopsis(synopsisKo.synopses?.[String(a.mal_id)]);
  const tmdb = translated ? { text: "", failed: false } : await koreanOverview(a);
  const fromTmdb =
    cleanSynopsis(tmdb.text) ||
    (tmdb.failed && old?.synopsisBy === "TMDB" ? old.synopsis || "" : "");
  let original = cleanSynopsis(a.synopsis);
  if (!translated && !fromTmdb && a.anilistId && isThinSynopsis(original)) {
    original = cleanSynopsis(await prequelSynopsis(a.anilistId)) || original;
  }
  const machine =
    !translated && !fromTmdb && original && !/[가-힣]/.test(original)
      ? await autoTranslate(a.mal_id, original, ko || a.title_english || a.title, a.title)
      : "";
  const synopsis = translated
    ? {
        synopsis: translated,
        synopsisBy: synopsisKo.source || "AniList",
        synopsisLang: "ko",
        synopsisTranslated: true,
      }
    : fromTmdb
      ? { synopsis: fromTmdb, synopsisBy: "TMDB", synopsisLang: "ko" }
      : machine
        ? {
            synopsis: machine,
            synopsisBy: a.provider || "AniList",
            synopsisLang: "ko",
            synopsisTranslated: true,
          }
        : original
          ? {
              synopsis: original,
              synopsisBy: a.provider || "AniList",
              synopsisLang: /[가-힣]/.test(original) ? "ko" : "en",
            }
          : {};

  works.push({
    malId: a.mal_id,
    title: ko || a.title_english || a.title,
    ...(ko ? { titleKo: ko } : {}),
    titleOriginal: a.title,
    ...synopsis,
    genres,
    episodes: a.episodes ?? null,
    score: a.score ?? null,
    members: a.members ?? null,
    studio: (a.studios || [])[0]?.name || "",
    season: a.season && a.year ? `${a.year} ${a.season}` : "",
    poster,
    posterCredit: a.provider || "MyAnimeList",
    scoreBy: a.provider || "MyAnimeList",
    malUrl: a.url ?? `https://myanimelist.net/anime/${a.mal_id}`,
  });
}

if (titleChanged) {
  const sorted = Object.fromEntries(
    Object.entries(titleCache.translations).sort(([x], [y]) => x.localeCompare(y, "en", { numeric: true })),
  );
  await writeFile(
    TITLE_AUTO,
    JSON.stringify({
      note: "애니 제목 자동 번역 캐시입니다. 수정할 제목은 anime-title-aliases.json 에 적습니다(그쪽이 우선).",
      model: TRANSLATE_MODEL,
      translations: sorted,
    }, null, 2) + "\n",
  );
}
if (autoChanged) {
  const sorted = Object.fromEntries(
    Object.entries(autoCache.translations).sort(([x], [y]) => x.localeCompare(y, "en", { numeric: true })),
  );
  await writeFile(
    SYNOPSIS_AUTO,
    JSON.stringify(
      {
        note:
          "애니 줄거리 원문(영어)의 자동 번역 캐시입니다. scripts/fetch-anime.mjs 가 채웁니다. " +
          "고칠 문장은 이 파일이 아니라 anime-synopsis-ko.json 에 옮겨 적습니다(그쪽이 우선).",
        model: TRANSLATE_MODEL,
        translations: sorted,
      },
      null,
      2,
    ) + "\n",
  );
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
  season: picked[0]?.season && picked[0]?.year
    ? `${picked[0].year} ${picked[0].season}`
    : "",
  updatedAt: new Date().toISOString().slice(0, 10),
  koreanTitles: "수동 보정 · TMDB · 자동 번역",
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
  const count = (f) => works.filter(f).length;
  console.log(
    `줄거리: TMDB 한국어 ${count((w) => w.synopsisBy === "TMDB")}편 · ` +
      `번역 ${count((w) => w.synopsisTranslated)}편 · ` +
      `원문 ${count((w) => w.synopsisLang === "en")}편 · ` +
      `없음 ${count((w) => !w.synopsis)}편`,
  );
  const untranslated = works.filter((w) => w.synopsisLang === "en");
  if (untranslated.length) {
    console.log(
      `  원문(영어)만 있는 작품 — ` +
        (translatorReady()
          ? "번역이 실패했거나 이번 실행의 번역 상한을 넘었습니다. 다음 실행에서 다시 봅니다: "
          : `ANTHROPIC_API_KEY 시크릿을 등록하면 자동 번역합니다(또는 ${SYNOPSIS_KO} 에 직접): `) +
        untranslated.map((w) => `${w.malId} ${w.title}`).join(" / "),
    );
  }
  const untranslatedTitles = works.filter((w) => !w.titleKo);
  if (untranslatedTitles.length) {
    console.log(`  영어 제목만 있는 작품 — ${untranslatedTitles.map((w) => `${w.malId} ${w.title}`).join(" / ")}`);
  }
}
