/**
 * 검색엔진·AI 검색이 읽는 부분을 사이트 내용과 맞춰 둡니다.
 * "콘텐츠 갱신" 워크플로가 매일 실행합니다. 네트워크는 쓰지 않습니다.
 *
 *  1. 기준 월 — webhard.html 의 <head> 와 <time data-seo-month> 에 있는
 *     "YYYY년 M월" 을 이번 달로 바꿉니다. 순위는 매주 월요일 바뀌므로
 *     "이번 달 기준" 은 늘 사실입니다.
 *  2. 구조화 데이터 — webhard.html 의 JSON-LD 를 비교표와 FAQ 에서 다시
 *     만듭니다. 화면의 질문·답과 JSON-LD 가 어긋나면 검색엔진이 무시합니다.
 *  3. 홈 순위 기본 마크업 — 스크립트를 실행하지 않는 수집기(네이버·AI
 *     크롤러 일부)도 목록을 읽도록 #ranking 안에 미리 그려 둡니다.
 *  4. 수정일 — 페이지 내용이 실제로 바뀐 날만 assets/seo-state.json 에
 *     적고 dateModified·sitemap lastmod 에 씁니다. 기준 월만 바뀐 것은
 *     수정으로 치지 않습니다.
 *  5. sitemap.xml, llms.txt 를 새로 씁니다.
 *
 * 쓰임: node scripts/update-seo.mjs [--date=YYYY-MM-DD]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const SITE = "https://mktperiod-a11y.github.io/ottbora/";
const ROOT = new URL("../", import.meta.url).pathname;
const STATE_FILE = "assets/seo-state.json";

const read = (f) => readFileSync(ROOT + f, "utf8");
const written = [];
const write = (f, s) => {
  if (existsSync(ROOT + f) && read(f) === s) return;
  writeFileSync(ROOT + f, s);
  written.push(f);
};

// 오늘(한국 시간)
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const today = dateArg
  ? dateArg.slice(7)
  : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const [yyyy, mm] = today.split("-");
const MONTH_LABEL = `${yyyy}년 ${Number(mm)}월`;
const MONTH_RE = /20\d{2}년 (?:1[0-2]|[1-9])월/g;

// ── HTML 조각 다루기 ─────────────────────────────────────────────
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};
const text = (html) =>
  html
    .replace(/<span aria-hidden="true">[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const must = (value, what) => {
  if (!value)
    throw new Error(
      `${what} 을(를) 찾지 못했습니다. 마크업이 바뀌었으면 이 스크립트도 고쳐 주세요.`,
    );
  return value;
};
const section = (html, id) =>
  must(
    html.match(
      new RegExp(`<section[^>]*\\bid="${id}"[\\s\\S]*?</section>`),
    )?.[0],
    `#${id} 구획`,
  );

// ── 웹하드 자료 ─────────────────────────────────────────────────
function loadRanking() {
  const window = {};
  vm.runInNewContext(read("assets/webhard-ranking.js"), {
    window,
    Date,
    Math,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  return must(window.OTT_WEBHARD_RANKING, "OTT_WEBHARD_RANKING");
}

/** 비교표 행: 화면에 보이는 순서 그대로, 숨긴 예비 후보 포함. */
function comparisonRows(html) {
  const tbody = must(
    section(html, "comparison").match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1],
    "비교표 tbody",
  );
  return [...tbody.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map(
    ([, attrs, body]) => {
      const [, id, label] = must(
        body.match(/<a href="#([\w-]+)"\s*>([\s\S]*?)<\/a\s*>/),
        "비교표 서비스 링크",
      );
      const cell = (name) =>
        text(
          body.match(
            new RegExp(`data-label="${name}">([\\s\\S]*?)</td>`),
          )?.[1] || "",
        );
      return {
        id,
        name: text(label),
        hidden: /\bhidden\b/.test(attrs),
        features: cell("주요 특징"),
        fit: cell("이런 분께 추천"),
      };
    },
  );
}

/** 추천 이유 카드: 한 줄 소개·추천 대상·주요 특징·공식 주소. */
function providerCards(html) {
  const cards = new Map();
  for (const [card, id] of section(html, "more").matchAll(
    /<article\s+class="provider[^"]*"\s+id="([\w-]+)"[\s\S]*?<\/article>/g,
  )) {
    const href = card.match(/class="visit[^"]*"\s+href="([^"]+)"/)?.[1] || "";
    cards.set(id, {
      // 이름 아래 한 줄 소개는 키워드 칩(<ul class="chips">)으로 바뀌었습니다.
      tagline: [
        ...(
          card.match(/<ul class="chips"[^>]*>([\s\S]*?)<\/ul>/)?.[1] || ""
        ).matchAll(/<li>([\s\S]*?)<\/li>/g),
      ]
        .map(([, li]) => text(li))
        .join(" · "),
      reason: text(
        card.match(/<div class="reason">[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1] || "",
      ),
      facts: [
        ...(
          card.match(/<div class="facts">([\s\S]*?)<\/div>/)?.[1] || ""
        ).matchAll(/<li>([\s\S]*?)<\/li>/g),
      ].map(([, li]) => text(li)),
      official: officialUrl(href),
    });
  }
  return cards;
}

/** go/<id>/ 이동 페이지면 실제 공식 주소를 읽어 옵니다. */
function officialUrl(href) {
  if (!href.startsWith("go/")) return href;
  const page = read(`${href.replace(/\/?$/, "/")}index.html`);
  return must(
    page.match(/http-equiv="refresh"\s+content="0;url=([^"]+)"/)?.[1],
    `${href} 이동 주소`,
  );
}

function faqItems(html) {
  return [...section(html, "faq").matchAll(/<details[\s\S]*?<\/details>/g)].map(
    ([d]) => ({
      q: text(
        must(
          d.match(/class="seed-accordion__title[^"]*">([\s\S]*?)<\/span>/)?.[1],
          "FAQ 질문",
        ),
      ),
      a: text(
        must(
          d.match(/<div class="seed-accordion__body">([\s\S]*?)<\/div>/)?.[1],
          "FAQ 답",
        ),
      ),
    }),
  );
}

function methodology(html) {
  const sec = section(html, "methodology");
  return {
    intro: text(
      sec.match(/<div class="method-intro">([\s\S]*?)<\/div>/)?.[1] || "",
    ),
    items: [
      ...sec.matchAll(
        /<article>[\s\S]*?<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g,
      ),
    ].map(([, h, p]) => `${text(h)} — ${text(p)}`),
  };
}

const headOf = (html) =>
  must(html.match(/<head>[\s\S]*?<\/head>/)?.[0], "<head>");
const titleOf = (html) =>
  text(must(html.match(/<title>([\s\S]*?)<\/title>/)?.[1], "<title>"));
const descriptionOf = (html) =>
  text(
    must(
      html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1],
      "meta description",
    ),
  );
const pageName = (html) => titleOf(html).replace(/\s+[-|]\s+오티티보라$/, "");

// ── 1. 기준 월 ──────────────────────────────────────────────────
function applyMonth(html) {
  const head = headOf(html);
  return html
    .replace(head, () => head.replace(MONTH_RE, MONTH_LABEL))
    .replace(
      /<time data-seo-month datetime="[^"]*">[^<]*<\/time>/g,
      `<time data-seo-month datetime="${yyyy}-${mm}">${MONTH_LABEL}</time>`,
    );
}

// ── 4. 수정일 ───────────────────────────────────────────────────
/** 기준 월·수정일·자동 생성 부분을 빼고 잰 내용 지문. */
function fingerprint(files) {
  const h = createHash("sha1");
  for (const f of files) {
    h.update(
      read(f)
        .replace(MONTH_RE, "@M")
        .replace(/<time data-seo-month datetime="[^"]*">/g, "@T")
        .replace(/"dateModified": "[^"]*"/g, "@D")
        .replace(
          /<script type="application\/ld\+json" data-seo-generated>[\s\S]*?<\/script>/g,
          "@J",
        )
        .replace(/<!-- seo:ranking -->[\s\S]*?<!-- \/seo:ranking -->/g, "@R"),
    );
  }
  return h.digest("hex").slice(0, 16);
}

const PAGES = {
  "": {
    html: "index.html",
    inputs: ["index.html", "assets/webhard-ranking.js"],
  },
  "webhard.html": {
    html: "webhard.html",
    inputs: ["webhard.html", "assets/webhard-ranking.js"],
  },
  "content.html": {
    html: "content.html",
    inputs: [
      "content.html",
      "assets/content-data.json",
      "assets/boxoffice.json",
      "assets/tv-ranking.json",
      "assets/anime.json",
    ].filter((f) => existsSync(ROOT + f)),
  },
  "criteria.html": { html: "criteria.html", inputs: ["criteria.html"] },
  "content-detail.html": {
    html: "content-detail.html",
    inputs: ["content-detail.html", "assets/content-data.json"],
  },
};

// ── 실행 ────────────────────────────────────────────────────────
const state = existsSync(ROOT + STATE_FILE) ? JSON.parse(read(STATE_FILE)) : {};
const ranking = loadRanking();

// 1·2. webhard.html
let webhard = applyMonth(read("webhard.html"));
const rows = comparisonRows(webhard);
const cards = providerCards(webhard);
const faq = faqItems(webhard);

// 3. 홈 순위 기본 마크업: 비교표의 정적 순서에서 지금 후보인 곳만 DISPLAY_LIMIT 개.
const active = new Set(ranking.allIds);
const homeOrder = [
  ...rows.filter((r) => !r.hidden),
  ...rows.filter((r) => r.hidden),
]
  .filter((r) => active.has(r.id))
  .slice(0, ranking.displayLimit);
const rankCards = homeOrder
  .map((r, i) => {
    const p = must(ranking.providers[r.id], `PROVIDERS.${r.id}`);
    const logo = p.logo
      ? `<img src="assets/${esc(p.logo)}" style="--k: ${p.logoK || 0.55}" alt="${esc(p.name)} 로고" loading="lazy" decoding="async">`
      : `<span class="brand-name">${esc(p.name)}</span>`;
    return (
      `<article class="rank-card"><div class="rank"><span class="home-rank-number">${i + 1}</span>` +
      `<span class="home-rank-move is-same">–</span></div><div class="brand">${logo}</div>` +
      `<div class="rank-info"><b>${esc(p.name)}</b><span>${esc(p.description)}</span></div>` +
      `<a class="go" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">공식 홈페이지</a></article>`
    );
  })
  .join("");
let index = read("index.html").replace(
  /<!-- seo:ranking -->[\s\S]*?<!-- \/seo:ranking -->/,
  () => `<!-- seo:ranking -->${rankCards}<!-- /seo:ranking -->`,
);
must(index.includes("<!-- seo:ranking -->"), "index.html 의 seo:ranking 표시");

// 2. webhard.html 구조화 데이터
const url = `${SITE}webhard.html`;
const graph = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE}#website`,
      url: SITE,
      name: "오티티보라",
      alternateName: ["OTT BORA", "오티티 보라"],
      inLanguage: "ko-KR",
    },
    {
      "@type": "Organization",
      "@id": `${SITE}#organization`,
      name: "오티티보라",
      url: SITE,
      logo: {
        "@type": "ImageObject",
        url: `${SITE}assets/apple-touch-icon.png`,
        width: 180,
        height: 180,
      },
    },
    {
      "@type": "CollectionPage",
      "@id": `${url}#webpage`,
      url,
      name: pageName(webhard),
      description: descriptionOf(webhard),
      inLanguage: "ko-KR",
      // 실제 날짜는 아래 dateModified 맞추기에서 씁니다.
      dateModified: state["webhard.html"]?.modified || today,
      isPartOf: { "@id": `${SITE}#website` },
      publisher: { "@id": `${SITE}#organization` },
      primaryImageOfPage: `${SITE}assets/og-webhard.png`,
      mainEntity: { "@id": `${url}#list` },
    },
    {
      "@type": "ItemList",
      "@id": `${url}#list`,
      name: "오티티보라 웹하드 비교 후보",
      // 추천 순서는 매주 월요일 바뀌므로 목록 자체는 순서 없는 후보 목록입니다.
      itemListOrder: "https://schema.org/ItemListUnordered",
      numberOfItems: rows.length,
      itemListElement: rows.map((r, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: r.name,
        url: `${url}#${r.id}`,
      })),
    },
    {
      "@type": "FAQPage",
      "@id": `${url}#faq`,
      mainEntity: faq.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
  ],
};
const jsonLd =
  `<script type="application/ld+json" data-seo-generated>\n` +
  JSON.stringify(graph, null, 2).replace(/</g, "\\u003c") +
  `\n    </script>`;
must(
  /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/.test(webhard),
  "webhard.html JSON-LD",
);
webhard = webhard.replace(
  /<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/,
  () => jsonLd,
);

// JSON-LD·홈 순위는 지문에서 빠지므로 먼저 써 두어도 됩니다.
write("webhard.html", webhard);
write("index.html", index);

const nextState = {};
for (const [path, page] of Object.entries(PAGES)) {
  const hash = fingerprint(page.inputs);
  const prev = state[path];
  nextState[path] = {
    hash,
    modified: prev && prev.hash === hash ? prev.modified : today,
  };
}
const modified = (path) => nextState[path].modified;

// 모든 JSON-LD 의 dateModified 를 지문으로 정한 날짜에 맞춥니다.
for (const [path, page] of Object.entries(PAGES)) {
  const html = read(page.html);
  write(
    page.html,
    html.replace(
      /"dateModified": "[^"]*"/g,
      `"dateModified": "${modified(path)}"`,
    ),
  );
}

// 5. sitemap.xml
// 손으로 넣은 작품 중 종영 후 만료된 것은 뺍니다(content.html 과 같은 규칙).
const contentData = JSON.parse(read("assets/content-data.json"));
const manualDate = (raw) => {
  const m = String(raw || "").match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
const manualExpired = (w, rule) => {
  if (!rule) return false;
  let end = manualDate(w.endedAt);
  if (!end) {
    const start = manualDate(w.releasedAt);
    const run = Number(rule.estimatedRunMonths?.[w.type]);
    if (!start || !run) return false;
    end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + run);
  }
  const until = new Date(end);
  until.setUTCMonth(until.getUTCMonth() + (Number(rule.afterEndMonths) || 6));
  return Date.now() > until.getTime();
};
const works = (contentData.works || []).filter((w) => !manualExpired(w, contentData.expiry));
const detailModified = modified("content-detail.html");
const urls = [
  [SITE, modified("")],
  [`${SITE}webhard.html`, modified("webhard.html")],
  [`${SITE}criteria.html`, modified("criteria.html")],
  [`${SITE}content.html`, modified("content.html")],
  ...works
    .filter((w) => w.id)
    .map((w) => [
      `${SITE}content-detail.html?id=${encodeURIComponent(w.id)}`,
      detailModified,
    ]),
];
write(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        ([loc, lastmod]) =>
          `  <url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod></url>`,
      )
      .join("\n") +
    `\n</urlset>\n`,
);

// 5. llms.txt — AI 검색이 인용하기 쉬운 요약
const method = methodology(webhard);
const listed = rows.map((r) => {
  const c = cards.get(r.id) || {};
  const status = active.has(r.id) ? "" : " (현재 순위 후보에서 빠짐)";
  return [
    `- ${r.name}${status}: ${c.tagline || r.features}`,
    c.reason ? `  - 추천: ${c.reason}` : "",
    ...(c.facts || []).map((f) => `  - ${f}`),
    c.official ? `  - 공식 홈페이지: ${c.official}` : "",
  ]
    .filter(Boolean)
    .join("\n");
});
write(
  "llms.txt",
  [
    "# 오티티보라 (OTT BORA)",
    "",
    `> 국내 웹하드(흔히 "P2P 사이트"로 불리는 파일 공유 서비스) ${rows.length}곳의 주요 기능과 추천 대상을 같은 틀로 비교하고, 영화·드라마·예능·애니 작품 정보를 소개하는 한국어 사이트입니다. ${MONTH_LABEL} 기준이며 추천 순서는 매주 월요일 갱신됩니다.`,
    "",
    "## 주요 페이지",
    `- [${pageName(webhard)}](${SITE}webhard.html): 비교 후보 ${rows.length}곳 중 추천 ${ranking.displayLimit}곳, 선정 기준, 자주 묻는 질문`,
    `- [${pageName(read("criteria.html"))}](${SITE}criteria.html): 가입 전에 확인할 조건`,
    `- [${pageName(read("content.html"))}](${SITE}content.html): 박스오피스와 화제의 드라마·예능, 인기 애니`,
    `- [홈](${SITE}): 웹하드 추천 순위와 오늘 볼 작품`,
    "",
    "## 비교 대상 웹하드",
    "추천 순서는 오티티보라의 편집 순서이며 매주 월요일 바뀝니다. 아래는 순서가 아니라 비교표에 실린 차례입니다.",
    "",
    ...listed,
    "",
    "## 추천 순서를 정하는 기준",
    method.intro,
    ...method.items.map((m) => `- ${m}`),
    "",
    "## 자주 묻는 질문",
    ...faq.flatMap(({ q, a }) => ["", `### ${q}`, a]),
    "",
  ].join("\n"),
);

write(STATE_FILE, JSON.stringify(nextState, null, 2) + "\n");
console.log(
  `기준 월 ${MONTH_LABEL} · 비교표 ${rows.length}곳 · FAQ ${faq.length}개 · 홈 순위 ${homeOrder.length}곳`,
);
console.log(
  written.length
    ? `바뀐 파일: ${[...new Set(written)].join(", ")}`
    : "바뀐 파일 없음",
);
