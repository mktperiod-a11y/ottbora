/*
 * 오티티보라 클릭 추적 (GA4).
 *
 * 웹하드 공식 홈페이지로 나가는 클릭을 모두 webhard_click 하나로 남깁니다.
 * 온디스크·케이디스크는 go/ondisk/ 같은 사이트 안쪽 주소를 거쳐 나가서
 * GA 의 자동 "이탈 클릭" 에 잡히지 않기 때문입니다.
 *
 *   provider        ondisk · kdisk · wedisk …   (어느 서비스로)
 *   provider_group  own(온디스크·케이디스크) · other(그 밖의 웹하드)
 *   rank            누를 때 보이던 순위(1~10). 배너처럼 순위가 없으면 비움
 *   placement       home_rank(홈 순위) · compare_card(웹하드 추천 카드)
 *                   · detail_banner(작품 상세 제휴 배너) · other
 *
 * GA 보고서에서 이 값들을 보려면 관리 → 맞춤 정의에서 같은 이름의
 * 이벤트 범위 맞춤 측정기준을 만들어야 합니다.
 */
(() => {
  "use strict";
  if (typeof window.gtag !== "function") return;

  const OWN = new Set(["ondisk", "kdisk"]);

  // 공식 홈페이지 주소(호스트) → 서비스 id. 랭킹 엔진이 있는 페이지에서만 채워집니다.
  const byHost = new Map();
  const providers = window.OTT_WEBHARD_RANKING?.providers || {};
  for (const p of Object.values(providers)) {
    try {
      byHost.set(new URL(p.url, location.href).hostname.replace(/^www\./, ""), p.id);
    } catch {}
  }

  function providerOf(a) {
    if (a.dataset.provider) return a.dataset.provider;
    const href = a.getAttribute("href") || "";
    const go = href.match(/(?:^|\/)go\/([a-z0-9-]+)\/?/i);
    if (go) return go[1].toLowerCase();
    try {
      const url = new URL(href, location.href);
      if (url.origin === location.origin) return "";
      return byHost.get(url.hostname.replace(/^www\./, "")) || "";
    } catch {
      return "";
    }
  }

  function placementOf(a) {
    if (a.closest("#ranking")) return "home_rank";
    if (a.closest("#more")) return "compare_card";
    if (a.closest(".promo")) return "detail_banner";
    return "other";
  }

  function rankOf(a) {
    const box = a.closest("article, tr");
    const el = box?.querySelector(".home-rank-number, .rank-number, .table-rank-number");
    const n = parseInt(el?.textContent || "", 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      const provider = providerOf(a);
      if (!provider) return;
      const params = {
        provider,
        provider_group: OWN.has(provider) ? "own" : "other",
        placement: placementOf(a),
        link_url: a.href,
        transport_type: "beacon",
      };
      const rank = rankOf(a);
      if (rank) params.rank = rank;
      window.gtag("event", "webhard_click", params);
    },
    true,
  );
})();
