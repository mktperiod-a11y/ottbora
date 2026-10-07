
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

function loadProviders() {
  const src = readFileSync("assets/webhard-ranking.js", "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const providers = { ...sandbox.window.OTT_WEBHARD_RANKING.providers };

  try {
    const cinema = JSON.parse(readFileSync("assets/cinema-links.json", "utf8"));
    for (const c of cinema.chains || []) {
      if (!c.id || !c.host || providers[c.id]) continue;
      providers[c.id] = {
        id: c.id,
        name: c.name,
        logo: c.logo || "",
        url: `https://${c.host}/`,
      };
    }
  } catch {}
  return providers;
}

function isHandmade(p) {
  if (!p.logo) return true;
  const file = `assets/${p.logo}`;
  if (!existsSync(file)) return true;
  if (!file.endsWith(".svg")) return false;
  const svg = readFileSync(file, "utf8");
  return /<text[\s>]/.test(svg);
}

const why = (e) =>
  [e?.message, e?.cause?.code, e?.cause?.reason, e?.cause?.message]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(" / ");

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
  let cur = url;
  let res;
  const tried = new Set();
  for (let hop = 0; hop < 10; hop += 1) {
    res = await fetch(cur, {
      headers: {
        "user-agent": UA,
        accept: asText ? "text/html,text/css,*/*" : "image/*,*/*",
        "accept-language": "ko-KR,ko;q=0.9",
        ...(referer ? { referer } : {}),
        ...cookieHeader(),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    remember(res);
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("location")
      ?? (res.headers.get("refresh") || "").match(/url\s*=\s*['"]?([^'";]+)/i)?.[1]
      ?? null;
    if (loc === null) break;
    const next = new URL(loc, cur).href;
    const key = `${next}\n${JSON.stringify(cookieHeader())}`;
    if (tried.has(key)) break;
    tried.add(key);
    referer = cur;
    cur = next;
    if (hop === 9) throw new Error("리다이렉트가 너무 많음");
  }
  Object.defineProperty(res, "finalUrl", { value: cur });
  const redirectBody = asText && res.status >= 300 && res.status < 400;
  if (!res.ok && !redirectBody) throw new Error(`HTTP ${res.status}`);
  if (redirectBody) console.warn(`    ${cur}: HTTP ${res.status} 인데 이동할 곳이 없어 본문을 읽습니다`);
  if (asText) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { url: res.finalUrl, text: decode(buf, res.headers.get("content-type") || "") };
  }
  const type = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`너무 큼 ${buf.length}B`);
  return { url: res.finalUrl, type, buf };
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

  for (const block of html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    for (const m of block.matchAll(/"logo"\s*:\s*(?:"([^"]+)"|\{[^}]*?"(?:url|contentUrl)"\s*:\s*"([^"]+)")/g)) {
      add((m[1] || m[2]).replace(/\\\//g, "/"), "ld", "schema.org logo");
    }
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = attr(tag, "src") || attr(tag, "data-src");
    const alt = attr(tag, "alt");
    const hay = [src, alt, attr(tag, "class"), attr(tag, "id")].join(" ");
    const named = siteName && alt.replace(/\s/g, "") === siteName.replace(/\s/g, "");
    if (/logo|로고|\bci\b|brand/i.test(hay) || named) add(src, "img", alt);
  }
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

let cssTexts = [];

function colorStats(texts) {
  const count = new Map();
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  for (const t of texts) {
    for (const m of t.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
      let r, g, b;
      if (m[1]) {
        const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
        [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      } else [r, g, b] = [m[2], m[3], m[4]].map(Number);
      if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue;
      const k = hex(r, g, b);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([color, n]) => ({ color, n }));
}

async function cssCandidates(html, base) {
  const out = [];
  const sheets = [];
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
    for (const rule of text.match(/[^{}]*(logo|\bci\b|\bh1\b)[^{}]*\{[^}]*\}/gi) || []) {
      for (const m of rule.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        try {
          out.push({ url: new URL(m[1], from).href, kind: "css", note: rule.split("{")[0].trim().slice(0, 60) });
        } catch {}
      }
    }
  };
  cssTexts.push(html);
  for (const block of html.match(/<style\b[\s\S]*?<\/style>/gi) || []) scan(block, base);
  for (const href of sheets.slice(0, 8)) {
    try {
      const { text } = await get(href, { referer: base, asText: true });
      cssTexts.push(text);
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

const providers = loadProviders();
const args = process.argv.slice(2);
const hostsOnly = args.includes("--hosts");
const wanted = args.filter((a) => !a.startsWith("--"));
const targets = Object.values(providers).filter((p) =>
  wanted.length ? wanted.includes(p.id) : isHandmade(p),
);

if (hostsOnly) {
  const hosts = new Set();
  for (const p of targets) {
    const site = /^https?:/.test(p.url) ? p.url : p.home || "";
    if (!site) continue;
    const h = new URL(site).hostname;
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
  const home = /^https?:/.test(p.url) ? p.url : p.home || p.official || "";
  const dir = `${OUT}/${p.id}`;
  await mkdir(dir, { recursive: true });
  const entry = { id: p.id, name: p.name, home, candidates: [], error: "" };

  if (!home) {
    entry.error = "공식 홈페이지 주소가 없습니다 (go/ 경로만 있음)";
    console.warn(`  ${p.name}: ${entry.error}`);
    report.push(entry);
    continue;
  }

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
  const docs = [page];
  for (let hop = 0; hop < 3; hop += 1) {
    const cur = docs[docs.length - 1];
    const refresh = (cur.text.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i) || [])[0];
    let target = refresh && (attr(refresh, "content").match(/url\s*=\s*['"]?([^'";]+)/i) || [])[1];
    if (!target && cur.text.length < 4000) {
      const js = cur.text.match(/location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.replace\(\s*['"]([^'"]+)['"]/i);
      target = js && (js[1] || js[2]);
    }
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

  await writeFile(`${dir}/home.html`, docs.map((d) => `\n${d.text}`).join("\n\n"));

  const seen = new Set();
  const found = [];
  cssTexts = [];
  for (const d of docs) {
    found.push(...findCandidates(d.text, d.url, p.name));
    found.push(...(await cssCandidates(d.text, d.url)));
  }
  await writeFile(`${dir}/colors.json`, JSON.stringify(colorStats(cssTexts), null, 2) + "\n");
  const unique = found.filter((c) => !seen.has(c.url) && seen.add(c.url));
  const ORDER = { ld: 0, img: 1, h1: 2, css: 3, og: 4, icon: 5 };
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
