/**
 * 웹하드 공식 홈페이지에서 로고 후보를 모읍니다.
 *
 * 실행: node scripts/fetch-logos.mjs [id ...]
 *       (id 를 안 주면 로고가 없거나 손으로 그린 곳만 봅니다)
 *
 * 왜 이 스크립트가 있나
 * ─────────────────────
 * 작업 환경(샌드박스)에서는 웹하드 사이트가 막혀 있어 로고를 받을 수
 * 없습니다. 그래서 새 곳을 넣을 때마다 로고를 Arial 글자로 "그려서"
 * 채우는 일이 반복됐습니다. 공식 로고처럼 보이지만 공식이 아닌 것은
 * 없는 것보다 나쁩니다.
 *
 * GitHub Actions 러너는 이 사이트들에 닿습니다. 여기서 홈페이지를 열어
 * 로고로 보이는 이미지를 전부 받아 logo-candidates/<id>/ 에 둡니다.
 * 어느 것이 진짜 워드마크인지는 사람이(또는 다음 작업자가) 눈으로
 * 보고 고릅니다. 자동으로 하나를 골라 끼우지 않는 이유는, og:image 는
 * 대개 홍보 배너이고 파비콘은 너무 작아서, 기계가 고르면 틀리기 쉽기
 * 때문입니다.
 *
 * 찾는 곳
 *   img      src·alt·class·id 에 logo 가 들어간 <img>
 *   css      같은 사이트 CSS 에서 선택자에 logo 가 들어간 규칙의 url()
 *   icon     <link rel="apple-touch-icon" / "icon">
 *   og       <meta property="og:image">
 */

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import sharp from "sharp";

const OUT = "logo-candidates";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_PER_SITE = 14;

// ── 후보 목록은 랭킹 엔진에서 그대로 읽습니다 (따로 적어 두면 어긋납니다) ──
function loadProviders() {
  const src = readFileSync("assets/webhard-ranking.js", "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  return sandbox.window.OTT_WEBHARD_RANKING.providers;
}

/** 로고가 없거나, 글자로 그린 SVG 면 "공식 로고 아님" 으로 봅니다. */
function isHandmade(p) {
  if (!p.logo) return true;
  const file = `assets/${p.logo}`;
  if (!existsSync(file)) return true;
  if (!file.endsWith(".svg")) return false;
  const svg = readFileSync(file, "utf8");
  // 글자(<text>)로 워드마크를 흉내 낸 파일
  return /<text[\s>]/.test(svg);
}

/** fetch 는 "fetch failed" 만 말하고 진짜 이유(DNS·TLS·연결 거부)는 cause 에 둡니다. */
const why = (e) =>
  [e?.message, e?.cause?.code, e?.cause?.reason, e?.cause?.message]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(" / ");

/*
 * 쿠키 보관함. 첫 방문에 쿠키를 심고 같은 주소로 되돌려 보내는
 * 사이트(빅파일)가 있어, 받은 쿠키를 다음 요청에 돌려줍니다.
 */
const jar = new Map();
function remember(res) {
  const list = res.headers.getSetCookie?.() || [];
  for (const line of list) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () =>
  jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {};

/*
 * 국내 웹하드는 EUC-KR(CP949) 로 쓴 페이지가 많습니다. res.text() 는
 * 늘 UTF-8 로 풀어 alt="로고" 같은 한글이 깨지고, 그래서 로고를 못
 * 알아봤습니다(피디팝). 머리글이나 <meta charset> 을 보고 풉니다.
 */
function decode(buf, type) {
  const head = buf.subarray(0, 4096).toString("latin1");
  const cs =
    (type.match(/charset=([\w-]+)/i) || [])[1] ||
    (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] ||
    "utf-8";
  try {
    return new TextDecoder(cs.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function get(url, { referer, asText = false } = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: asText ? "text/html,text/css,*/*" : "image/*,*/*",
      "accept-language": "ko-KR,ko;q=0.9",
      ...(referer ? { referer } : {}),
      ...cookieHeader(),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  remember(res);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (asText) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { url: res.url, text: decode(buf, res.headers.get("content-type") || "") };
  }
  const type = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`너무 큼 ${buf.length}B`);
  return { url: res.url, type, buf };
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
};

function findCandidates(html, base, siteName = "") {
  const out = [];
  const add = (raw, kind, note = "") => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:")) return;
    try {
      out.push({ url: new URL(raw.trim(), base).href, kind, note });
    } catch {}
  };

  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    const alt = attr(tag, "alt");
    const hay = [src, alt, attr(tag, "class"), attr(tag, "id")].join(" ");
    // alt 가 사이트 이름 그대로인 이미지는 대개 로고입니다("피디팝", "빅파일").
    const named = siteName && alt.replace(/\s/g, "") === siteName.replace(/\s/g, "");
    if (/logo|로고|\bci\b|brand/i.test(hay) || named) add(src, "img", alt);
  }
  // 머리 <h1> 안의 이미지는 거의 늘 로고입니다.
  for (const h1 of html.match(/<h1\b[\s\S]{0,600}?<\/h1>/gi) || []) {
    for (const tag of h1.match(/<img\b[^>]*>/gi) || []) {
      add(attr(tag, "src") || attr(tag, "data-src"), "h1", attr(tag, "alt"));
    }
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, "rel").toLowerCase();
    if (/apple-touch-icon|(^|\s)icon/.test(rel)) add(attr(tag, "href"), "icon", rel);
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const prop = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    if (prop === "og:image" || prop === "twitter:image") add(attr(tag, "content"), "og", prop);
  }
  return out;
}

/** 같은 사이트 CSS 에서 logo 가 들어간 선택자의 배경 이미지를 찾습니다. */
async function cssCandidates(html, base) {
  const out = [];
  const sheets = [];
  // img.megafile.co.kr 처럼 같은 도메인의 이미지 서버는 같은 사이트로 봅니다.
  const site = new URL(base).hostname.split(".").slice(-3).join(".").replace(/^(www|m)\./, "");
  const sameSite = (h) => h === site || h.endsWith("." + site);
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/stylesheet/i.test(attr(tag, "rel"))) continue;
    try {
      const u = new URL(attr(tag, "href"), base);
      if (sameSite(u.hostname)) sheets.push(u.href);
    } catch {}
  }
  const scan = (text, from) => {
    // 선택자에 logo·ci·h1 이 들어간 규칙의 배경 이미지
    for (const rule of text.match(/[^{}]*(logo|\bci\b|\bh1\b)[^{}]*\{[^}]*\}/gi) || []) {
      for (const m of rule.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        try {
          out.push({ url: new URL(m[1], from).href, kind: "css", note: rule.split("{")[0].trim().slice(0, 60) });
        } catch {}
      }
    }
  };
  for (const block of html.match(/<style\b[\s\S]*?<\/style>/gi) || []) scan(block, base);
  for (const href of sheets.slice(0, 8)) {
    try {
      const { text } = await get(href, { referer: base, asText: true });
      scan(text, href);
    } catch {}
  }
  return out;
}

function extOf(type, url) {
  if (/svg/.test(type) || /\.svg(\?|$)/i.test(url)) return "svg";
  if (/png/.test(type) || /\.png(\?|$)/i.test(url)) return "png";
  if (/gif/.test(type) || /\.gif(\?|$)/i.test(url)) return "gif";
  if (/webp/.test(type) || /\.webp(\?|$)/i.test(url)) return "webp";
  if (/icon|ico/.test(type) || /\.ico(\?|$)/i.test(url)) return "ico";
  if (/jpe?g/.test(type) || /\.jpe?g(\?|$)/i.test(url)) return "jpg";
  return "";
}

// ── 실행 ────────────────────────────────────────────────────────────────
const providers = loadProviders();
const args = process.argv.slice(2);
const hostsOnly = args.includes("--hosts");
const wanted = args.filter((a) => !a.startsWith("--"));
const targets = Object.values(providers).filter((p) =>
  wanted.length ? wanted.includes(p.id) : isHandmade(p),
);

/*
 * --hosts: 대상 사이트의 호스트 이름만 한 줄씩 찍고 끝냅니다.
 * 워크플로가 인증서 사슬을 보완할 호스트를 고를 때 씁니다.
 */
if (hostsOnly) {
  const hosts = new Set();
  for (const p of targets) {
    if (!/^https?:/.test(p.url)) continue;
    const h = new URL(p.url).hostname;
    const bare = h.replace(/^(www|m)\./, "");
    hosts.add(h).add(bare).add(`www.${bare}`);
  }
  console.log([...hosts].join("\n"));
  process.exit(0);
}

if (!targets.length) {
  console.log("공식 로고가 빠진 곳이 없습니다.");
  process.exit(0);
}

console.log(`로고 후보를 모읍니다: ${targets.map((p) => p.name).join(", ")}\n`);
await rm(OUT, { recursive: true, force: true });
const report = [];

for (const p of targets) {
  const home = /^https?:/.test(p.url) ? p.url : p.official || "";
  const dir = `${OUT}/${p.id}`;
  await mkdir(dir, { recursive: true });
  const entry = { id: p.id, name: p.name, home, candidates: [], error: "" };

  if (!home) {
    entry.error = "공식 홈페이지 주소가 없습니다 (go/ 경로만 있음)";
    console.warn(`  ${p.name}: ${entry.error}`);
    report.push(entry);
    continue;
  }

  /*
   * 한 주소로 안 열리면 몇 가지를 더 해 봅니다. www 유무에 따라 인증서가
   * 다르거나, 해외 접속을 모바일 주소로만 받는 곳이 있습니다.
   */
  const tries = (() => {
    const u = new URL(home);
    const bare = u.hostname.replace(/^(www|m)\./, "");
    const hosts = [u.hostname, `www.${bare}`, bare, `m.${bare}`];
    const list = [];
    for (const h of hosts) for (const proto of ["https:", "http:"]) list.push(`${proto}//${h}/`);
    return [...new Set([home, ...list])];
  })();

  let page;
  const failures = [];
  for (const url of tries) {
    try {
      page = await get(url, { asText: true });
      if (url !== home) console.log(`  ${p.name}: ${home} 대신 ${url} 로 열었습니다`);
      break;
    } catch (e) {
      failures.push(`${url} → ${why(e)}`);
    }
  }
  if (!page) {
    entry.error = "홈페이지를 열지 못함";
    entry.tried = failures;
    console.warn(`  ${p.name}: 홈페이지를 열지 못했습니다`);
    for (const f of failures) console.warn(`      ${f}`);
    report.push(entry);
    continue;
  }
  /*
   * 껍데기 페이지를 따라 들어갑니다.
   *
   *   meta refresh  <meta http-equiv="refresh" content="1;url=...">
   *                 빅파일은 첫 방문에 쿠키를 심고 같은 주소로 되돌려
   *                 보냅니다. 쿠키를 들고 다시 열면 본문이 옵니다.
   *   frameset      파일노리는 <frameset> 안에 진짜 페이지
   *                 (/noriNew/home.do)를 담아 둡니다.
   */
  const docs = [page];
  for (let hop = 0; hop < 3; hop += 1) {
    const cur = docs[docs.length - 1];
    const refresh = (cur.text.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i) || [])[0];
    const target = refresh && (attr(refresh, "content").match(/url\s*=\s*['"]?([^'";]+)/i) || [])[1];
    if (!target) break;
    try {
      const next = await get(new URL(target, cur.url).href, { referer: cur.url, asText: true });
      console.log(`  ${p.name}: 새로고침 안내를 따라 ${next.url} 를 다시 열었습니다`);
      docs.push(next);
    } catch (e) {
      console.warn(`  ${p.name}: 새로고침 대상 ${target} 실패 — ${why(e)}`);
      break;
    }
  }
  for (const tag of docs[docs.length - 1].text.match(/<i?frame\b[^>]*>/gi) || []) {
    const src = attr(tag, "src");
    if (!src || /^(about:|javascript:)/i.test(src)) continue;
    try {
      const u = new URL(src, docs[docs.length - 1].url);
      if (u.hostname.replace(/^(www|m)\./, "") !== new URL(page.url).hostname.replace(/^(www|m)\./, "")) continue;
      const inner = await get(u.href, { referer: page.url, asText: true });
      console.log(`  ${p.name}: 프레임 안 페이지 ${inner.url} 도 봅니다`);
      docs.push(inner);
    } catch (e) {
      console.warn(`  ${p.name}: 프레임 ${src} 실패 — ${why(e)}`);
    }
  }

  await writeFile(`${dir}/home.html`, docs.map((d) => `<!-- ${d.url} -->\n${d.text}`).join("\n\n"));

  const seen = new Set();
  const found = [];
  for (const d of docs) {
    found.push(...findCandidates(d.text, d.url, p.name));
    found.push(...(await cssCandidates(d.text, d.url)));
  }
  const unique = found.filter((c) => !seen.has(c.url) && seen.add(c.url));
  // 로고일 가능성이 높은 순서로 둡니다. 개수 상한에 걸려도 좋은 후보가 남게.
  const ORDER = { img: 0, h1: 1, css: 2, og: 3, icon: 4 };
  unique.sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));

  let n = 0;
  for (const c of unique.slice(0, MAX_PER_SITE)) {
    try {
      const img = await get(c.url, { referer: page.url });
      const ext = extOf(img.type, img.url);
      if (!ext) throw new Error(`이미지 아님 (${img.type || "형식 없음"})`);
      n += 1;
      const base = `${String(n).padStart(2, "0")}-${c.kind}`;
      await writeFile(`${dir}/${base}.${ext}`, img.buf);

      // 눈으로 고를 수 있게 PNG 미리보기를 만듭니다(SVG·ICO 포함).
      let meta = {};
      try {
        const s = sharp(img.buf, { density: 200 });
        meta = await s.metadata();
        await s
          .resize({ width: 480, height: 160, fit: "inside", withoutEnlargement: false })
          .flatten({ background: "#ffffff" })
          .png()
          .toFile(`${dir}/${base}.preview.png`);
      } catch {}

      entry.candidates.push({
        file: `${base}.${ext}`,
        kind: c.kind,
        note: c.note,
        url: img.url,
        bytes: img.buf.length,
        width: meta.width || null,
        height: meta.height || null,
      });
      console.log(`  ${p.name}  ${base}.${ext}  ${meta.width || "?"}×${meta.height || "?"}  ${c.kind}  ${img.url}`);
    } catch (e) {
      console.warn(`  ${p.name}  건너뜀 ${c.url}: ${why(e)}`);
    }
  }
  if (!entry.candidates.length) entry.error = "로고로 보이는 이미지를 찾지 못함";
  report.push(entry);
}

await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2) + "\n");
const ok = report.filter((r) => r.candidates.length).length;
console.log(`\n후보를 찾은 곳 ${ok} / ${report.length}`);
for (const r of report) if (r.error) console.log(`  못 찾음 — ${r.name}: ${r.error}`);
