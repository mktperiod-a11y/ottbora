/**
 * 박스오피스 목록의 작품에 포스터를 붙입니다.
 *
 * 실행:
 *   KMDB_API_KEY=... node scripts/fetch-posters.mjs
 *   TMDB_API_KEY=... node scripts/fetch-posters.mjs
 *
 * KOFIC 은 포스터를 주지 않습니다(응답에 이미지 필드가 없습니다). 그래서
 * 이미지는 따로 받아야 합니다. 두 곳을 지원하고, 등록된 키가 있는 쪽을 씁니다.
 *
 *   KMDb  한국영상자료원. 한국 개봉작 포스터에 강합니다.
 *   TMDB  외화·극장 애니 쪽 커버리지가 좋습니다.
 *
 * 둘 다 있으면 KMDb 를 먼저 보고 못 찾을 때만 TMDB 로 넘어갑니다.
 * 키가 없으면 무엇이 필요한지 알리고 그냥 끝냅니다 — 포스터가 없어도
 * 사이트는 글자 카드로 동작하므로 이건 실패가 아닙니다.
 *
 * 받은 이미지는 저장소에 내려받아 2:3 으로 맞춰 webp 로 저장합니다.
 * 남의 서버 주소를 그대로 걸면 상대가 주소를 바꾸거나 핫링크를 막을 때
 * 깨지고, 원본 비율이 제각각이면 목록이 흐트러집니다.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";

const DATA = "assets/boxoffice.json";
const DIR = "assets/posters";

/** 카드에 쓰는 크기. 2:3 은 포스터 표준 비율입니다. */
const W = 400;
const H = 600;

/** 한 번 실행에서 이 시간이 지나면 남은 작품은 다음 실행에 넘깁니다. */
const BUDGET_MS = 8 * 60 * 1000;

const KMDB = process.env.KMDB_API_KEY;
const TMDB = process.env.TMDB_API_KEY;

const KMDB_URL = "https://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json2.jsp";
const TMDB_URL = "https://api.themoviedb.org/3/search/movie";
const TMDB_IMG = "https://image.tmdb.org/t/p/w500";

if (!KMDB && !TMDB) {
  console.log("포스터 출처 키가 없습니다. 둘 중 하나를 저장소 Secrets 에 등록하세요.\n");
  console.log("  KMDB_API_KEY  한국영상자료원 — 한국 개봉작에 강합니다");
  console.log("                https://www.kmdb.or.kr/info/api/apiDetail/6");
  console.log("  TMDB_API_KEY  외화·극장 애니 커버리지가 좋습니다");
  console.log("                https://www.themoviedb.org/settings/api\n");
  console.log("키가 없어도 사이트는 글자 카드로 동작하므로 여기서 정상 종료합니다.");
  process.exit(0);
}

console.log(
  "쓸 출처:",
  [KMDB && "KMDb", TMDB && "TMDB"].filter(Boolean).join(" → "),
);

/**
 * 응답 형태가 예상과 다르면 그 작품만 건너뜁니다.
 * 잘못된 이미지를 싣는 것보다 포스터 한 칸이 비는 편이 낫습니다.
 */
async function getJson(url, label, { attempts = 2, timeout = 10000 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
  throw new Error(`${label}: ${last?.cause?.code || last?.message}`);
}

/** "2026-09-16" 또는 "20260916" → "2026" */
const yearOf = (s) => String(s || "").slice(0, 4);

/** 제목 비교용. 공백·문장부호를 떼고 맞춥니다(페이지의 중복 정리와 같은 방식). */
const norm = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");

/**
 * KMDb 에서 포스터 주소를 찾습니다.
 * posters 필드는 여러 장이 "|" 로 이어져 옵니다. 첫 장을 씁니다.
 */
async function fromKmdb(title, year) {
  const q = new URLSearchParams({
    collection: "kmdb_new",
    ServiceKey: KMDB,
    title,
    listCount: "10",
    detail: "Y",
  });
  const body = await getJson(`${KMDB_URL}?${q}`, `KMDb ${title}`);
  const list = body?.Data?.[0]?.Result;
  if (!Array.isArray(list)) return null;

  const want = norm(title);
  const hits = [];
  for (const r of list) {
    const got = norm(String(r.title || "").replace(/!H[SE]/g, ""));
    if (!got) continue;
    if (!(got === want || got.includes(want) || want.includes(got))) continue;

    const poster = String(r.posters || "").split("|").filter(Boolean)[0] || "";
    const plots = Array.isArray(r.plots?.plot)
      ? r.plots.plot
      : Array.isArray(r.plots)
        ? r.plots
        : [];
    const synopsis =
      plots.map((p) => String(p?.plotText || p?.plot || "").trim()).find(Boolean) ||
      String(r.plot || r.plotText || "").trim();

    hits.push({
      poster,
      synopsis,
      year: yearOf(r.repRlsDate) || yearOf(r.prodYear),
    });
  }
  if (!hits.length) return null;

  const pick = (year && hits.find((h) => h.year === year)) || hits[0];
  return {
    url: pick.poster || "",
    credit: "KMDb · 한국영상자료원",
    referer: "https://www.kmdb.or.kr/",
    synopsis: pick.synopsis || "",
    synopsisCredit: pick.synopsis ? "KMDb · 한국영상자료원" : "",
  };
}

/** TMDB 에서 포스터 주소를 찾습니다. */
async function fromTmdb(title, year) {
  const q = new URLSearchParams({
    api_key: TMDB,
    query: title,
    language: "ko-KR",
  });
  const body = await getJson(`${TMDB_URL}?${q}`, `TMDB ${title}`);
  const list = body?.results;
  if (!Array.isArray(list)) return null;

  const want = norm(title);
  const match = (t) => {
    const g = norm(t);
    return g && (g === want || g.includes(want) || want.includes(g));
  };
  const hits = list.filter((r) => match(r.title) || match(r.original_title));
  if (!hits.length) return null;

  const pick =
    (year && hits.find((r) => yearOf(r.release_date) === year)) || hits[0];
  return {
    url: pick.poster_path ? TMDB_IMG + pick.poster_path : "",
    credit: "TMDB",
    referer: "https://www.themoviedb.org/",
    synopsis: String(pick.overview || "").trim(),
    synopsisCredit: pick.overview ? "TMDB" : "",
    tmdbId: pick.id ?? null,
    score:
      Number(pick.vote_count) > 0 && Number(pick.vote_average) > 0
        ? Number(Number(pick.vote_average).toFixed(1))
        : null,
    voteCount: Number(pick.vote_count) || null,
  };
}

/** 한 장이 이보다 크면 받지 않습니다. 포스터가 이럴 일은 없습니다. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * 이미지를 받아 2:3 webp 로 저장합니다.
 *
 * 포스터는 API 와 다른 호스트에 있습니다(KMDb 는 file.koreafilm.or.kr).
 * 그런 호스트는 브라우저가 아닌 요청을 거절하는 경우가 있어, 평범한
 * 브라우저처럼 보이는 헤더를 붙입니다. 거절되면 그 작품만 건너뜁니다.
 *
 * 한 번 받아 저장소에 넣으므로 방문자 브라우저는 이 호스트에 붙지 않습니다.
 * 상대가 나중에 핫링크를 막아도 이미 받아 둔 이미지는 그대로 뜹니다.
 */
async function save(url, file, referer) {
  const res = await fetch(url, {
    headers: {
      // 서버 쪽 요청을 막는 호스트가 있어 붙입니다.
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      ...(referer ? { referer } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`이미지 HTTP ${res.status}`);

  // 차단 페이지가 HTML 로 오는 경우가 있어 형태를 먼저 봅니다.
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) {
    throw new Error(`이미지가 아님 (content-type: ${type || "없음"})`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error(`너무 큼 (${Math.round(len / 1024 / 1024)}MB)`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("너무 큼");

  // position:attention 은 사람 얼굴·대비가 큰 쪽을 남깁니다.
  // 원본이 가로 스틸컷이어도 인물이 잘려 나가지 않게 하려는 것입니다.
  // sharp 는 이미지가 아닌 입력에 예외를 던지므로 여기서 한 번 더 걸립니다.
  const out = await sharp(buf)
    .resize(W, H, { fit: "cover", position: "attention" })
    .webp({ quality: 82 })
    .toBuffer();
  await writeFile(file, out);
  return out.length;
}

// ---- 실행 ---------------------------------------------------------------

const raw = await readFile(DATA, "utf8");
const data = JSON.parse(raw);
if (!Array.isArray(data.movies)) {
  console.error(`${DATA} 의 movies 가 배열이 아닙니다.`);
  process.exit(1);
}

await mkdir(DIR, { recursive: true });

const need = data.movies.filter((m) => {
  if (!m.movieCd) return false;
  const hasPoster = Boolean(m.poster && existsSync(`${DIR}/${m.movieCd}.webp`));
  // 포스터가 있어도 줄거리/평점이 비어 있으면 메타데이터를 다시 찾습니다.
  return !hasPoster || !m.synopsis || m.score == null;
});

console.log(`${data.movies.length}편 중 포스터/상세 보강이 필요한 작품 ${need.length}편`);

const started = Date.now();
let ok = 0, fail = 0, skipped = 0, bytes = 0, metaUpdated = 0;

for (const m of need) {
  if (Date.now() - started > BUDGET_MS) {
    skipped += 1;
    continue;
  }

  const year = yearOf(m.openedAt);
  const hasPoster = Boolean(m.poster && existsSync(`${DIR}/${m.movieCd}.webp`));
  let kmdb = null;
  let tmdb = null;

  // 한국어 제목으로 못 찾는 재개봉·극장판은 KOFIC 영문명/원제로 한 번 더 찾습니다.
  if (TMDB) {
    const queries = [m.title, m.titleEn, m.titleOriginal]
      .map((x) => String(x || "").trim())
      .filter((x, i, arr) => x && arr.indexOf(x) === i);
    for (const query of queries) {
      try {
        tmdb = await fromTmdb(query, year);
      } catch (e) {
        console.warn(`  TMDB 조회 실패 — ${m.title} / ${query}: ${e.message}`);
      }
      if (tmdb?.synopsis || tmdb?.url || tmdb?.tmdbId) break;
    }
  }

  // 포스터가 없거나 TMDB 줄거리가 없을 때 KMDb 를 보조 출처로 봅니다.
  if (KMDB && (!hasPoster || !tmdb?.synopsis)) {
    try {
      kmdb = await fromKmdb(m.title, year);
    } catch (e) {
      console.warn(`  KMDb 조회 실패 — ${m.title}: ${e.message}`);
    }
  }

  let changed = false;
  if (tmdb?.synopsis || kmdb?.synopsis) {
    const synopsis = tmdb?.synopsis || kmdb?.synopsis || "";
    const credit = tmdb?.synopsis ? tmdb.synopsisCredit : kmdb?.synopsisCredit;
    if (synopsis && synopsis !== m.synopsis) {
      m.synopsis = synopsis;
      m.synopsisCredit = credit || "";
      changed = true;
    }
  }
  if (tmdb?.tmdbId && tmdb.tmdbId !== m.tmdbId) {
    m.tmdbId = tmdb.tmdbId;
    changed = true;
  }
  if (tmdb?.score != null && tmdb.score !== m.score) {
    m.score = tmdb.score;
    m.scoreBy = "TMDB";
    m.voteCount = tmdb.voteCount;
    changed = true;
  }
  if (changed) metaUpdated += 1;

  if (!hasPoster) {
    // 포스터 우선순위는 기존과 동일하게 KMDb → TMDB 입니다.
    let found = kmdb?.url ? kmdb : null;
    if (!found && KMDB) {
      try {
        found = await fromKmdb(m.title, year);
        kmdb ||= found;
      } catch (e) {
        console.warn(`  KMDb 포스터 조회 실패 — ${m.title}: ${e.message}`);
      }
    }
    if (!found?.url && tmdb?.url) found = tmdb;

    if (!found?.url) {
      fail += 1;
      console.warn(`  포스터 못 찾음 — ${m.title} (${year})`);
    } else {
      try {
        const size = await save(found.url, `${DIR}/${m.movieCd}.webp`, found.referer);
        m.poster = `${DIR}/${m.movieCd}.webp`;
        m.posterCredit = found.credit;
        ok += 1;
        bytes += size;
        console.log(`  ${m.title} — ${found.credit} (${Math.round(size / 1024)}KB)`);
      } catch (e) {
        fail += 1;
        console.warn(`  내려받기 실패 — ${m.title}: ${e.message}`);
      }
    }
  }

  await new Promise((r) => setTimeout(r, 250));
}

console.log(
  `\n포스터 새로 ${ok}편 (${Math.round(bytes / 1024)}KB) / 못 찾음 ${fail}편 / 상세 보강 ${metaUpdated}편` +
    (skipped ? ` / 시간이 차서 미룸 ${skipped}편` : ""),
);
if (skipped) console.log("미룬 작품은 다음 실행에서 다시 시도합니다.");

if (ok || metaUpdated) {
  await writeFile(DATA, JSON.stringify(data, null, 2) + "\n");
  console.log(`${DATA} 갱신`);
} else {
  console.log("새로 받은 포스터나 상세 정보가 없어 파일을 그대로 둡니다.");
}
