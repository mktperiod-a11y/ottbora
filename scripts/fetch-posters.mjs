
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";

const DATA = "assets/boxoffice.json";
const DIR = "assets/posters";

const W = 400;
const H = 600;

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

const yearOf = (s) => String(s || "").slice(0, 4);

const norm = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");

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

const MAX_BYTES = 12 * 1024 * 1024;

async function save(url, file, referer) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      ...(referer ? { referer } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`이미지 HTTP ${res.status}`);

  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) {
    throw new Error(`이미지가 아님 (content-type: ${type || "없음"})`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error(`너무 큼 (${Math.round(len / 1024 / 1024)}MB)`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("너무 큼");

  const out = await sharp(buf)
    .resize(W, H, { fit: "cover", position: "attention" })
    .webp({ quality: 82 })
    .toBuffer();
  await writeFile(file, out);
  return out.length;
}


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
