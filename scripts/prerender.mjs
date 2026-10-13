import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.argv[2] || "_site";
const SITE = (process.env.SITE_URL || "").replace(/\/?$/, "/");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

const server = createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    if (!file.startsWith(normalize(ROOT))) throw new Error("bad path");
    if ((await stat(file)).isDirectory()) throw new Error("dir");
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const ctx = await browser.newContext();

const ids = new Set();
const collect = async (url) => {
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "networkidle" });
  for (const href of await p.$$eval('a[href*="content-detail.html?id="]', (as) =>
    as.map((a) => a.getAttribute("href")),
  )) {
    const id = new URL(href, ORIGIN).searchParams.get("id") || "";
    if (/^[\w-]+$/.test(id)) ids.add(id);
  }
  await p.close();
};
await collect(`${ORIGIN}index.html`);
for (const tab of ["전체", "영화", "드라마", "예능", "애니"]) {
  for (let page = 1; page <= 3; page += 1) {
    await collect(`${ORIGIN}content.html?tab=${encodeURIComponent(tab)}&page=${page}`);
  }
}

await mkdir(join(ROOT, "content"), { recursive: true });
const done = [];
const queue = [...ids];
const render = async (id) => {
  const p = await ctx.newPage();
  await p.goto(`${ORIGIN}content-detail.html?id=${id}`, { waitUntil: "networkidle" });
  const ok = await p
    .waitForFunction(
      () =>
        document.title.includes("줄거리·정보") &&
        document.querySelector("#synopsis")?.textContent.trim(),
      null,
      { timeout: 10000 },
    )
    .then(() => true, () => false);
  const noindex = await p.$eval('meta[name="robots"]', (m) => m.content.includes("noindex"));
  if (!ok || noindex) {
    console.log(`건너뜀 ${id}`);
    await p.close();
    return;
  }
  const html = await p.evaluate((workId) => {
    const doc = document.documentElement.cloneNode(true);
    doc.dataset.workId = workId;
    const promo = doc.querySelector("#promo");
    if (promo) {
      promo.innerHTML = "";
      promo.hidden = true;
    }
    const base = document.createElement("base");
    base.href = "../";
    const head = doc.querySelector("head");
    const charset = head.querySelector("meta[charset]");
    if (charset) charset.after(base);
    else head.prepend(base);
    for (const a of doc.querySelectorAll('a[href^="#"]')) {
      a.setAttribute("href", `content/${workId}.html${a.getAttribute("href")}`);
    }
    return "<!doctype html>\n" + doc.outerHTML;
  }, id);
  await writeFile(join(ROOT, "content", `${id}.html`), html);
  done.push(id);
  await p.close();
};
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length) await render(queue.shift());
  }),
);
await browser.close();
server.close();

if (!done.length) throw new Error("작품 페이지를 하나도 만들지 못했습니다");

const today = new Date().toISOString().slice(0, 10);
const sitemapPath = join(ROOT, "sitemap.xml");
const old = await readFile(sitemapPath, "utf8");
const kept = [...old.matchAll(/<url>[\s\S]*?<\/url>/g)]
  .map(([u]) => u)
  .filter((u) => !u.includes("content-detail.html"));
const made = new Set(done);
const added = [...ids].filter((id) => made.has(id)).map(
  (id) => `<url><loc>${SITE}content/${id}.html</loc><lastmod>${today}</lastmod></url>`,
);
await writeFile(
  sitemapPath,
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...kept, ...added].map((u) => `  ${u}`).join("\n") +
    `\n</urlset>\n`,
);
console.log(`작품 페이지 ${done.length}개, 사이트맵 ${kept.length + added.length}개 주소`);
