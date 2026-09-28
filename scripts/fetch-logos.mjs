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

async function get(url, { referer, asText = false } = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: asText ? "text/html,text/css,*/*" : "image/*,*/*",
      "accept-language": "ko-KR,ko;q=0.9",
      ...(referer ? { referer } : {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (asText) return { url: res.url, text: await res.text() };
  const type = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`너무 큼 ${buf.length}B`);
  return { url: res.url, type, buf };
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
};

function findCandidates(html, base) {
  const out = [];
  const add = (raw, kind, note = "") => {
    if (!raw || raw.startsWith("data:") || raw.startsWith("javascript:")) return;
    try {
      out.push({ url: new URL(raw.trim(), base).href, kind, note });
    } catch {}
  };

  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    const hay = [src, attr(tag, "alt"), attr(tag, "class"), attr(tag, "id")].join(" ");
    if (/logo|로고|\bci\b|brand/i.test(hay)) add(src, "img", attr(tag, "alt"));
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
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/stylesheet/i.test(attr(tag, "rel"))) continue;
    try {
      const u = new URL(attr(tag, "href"), base);
      if (u.hostname.replace(/^www\./, "") === new URL(base).hostname.replace(/^www\./, "")) {
        sheets.push(u.href);
      }
    } catch {}
  }
  for (const href of sheets.slice(0, 6)) {
    try {
      const { text } = await get(href, { referer: base, asText: true });
      for (const rule of text.match(/[^{}]*logo[^{}]*\{[^}]*\}/gi) || []) {
        for (const m of rule.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
          try {
            out.push({ url: new URL(m[1], href).href, kind: "css", note: rule.split("{")[0].trim().slice(0, 60) });
          } catch {}
        }
      }
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
const wanted = process.argv.slice(2);
const targets = Object.values(providers).filter((p) =>
  wanted.length ? wanted.includes(p.id) : isHandmade(p),
);

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
  await writeFile(`${dir}/home.html`, page.text);

  const seen = new Set();
  const found = [
    ...findCandidates(page.text, page.url),
    ...(await cssCandidates(page.text, page.url)),
  ].filter((c) => !seen.has(c.url) && seen.add(c.url));

  let n = 0;
  for (const c of found.slice(0, MAX_PER_SITE)) {
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
