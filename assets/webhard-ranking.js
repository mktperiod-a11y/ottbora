(() => {
  "use strict";

  const PRIMARY = ["ondisk", "kdisk"];
  const CHALLENGERS = ["filejo", "wedisk", "filenori"];

  /* 늘 순위 추첨에 들어가는 곳. */
  const ACTIVE = [
    "ondisk", "kdisk", "wedisk", "filejo", "filenori",
    "me2disk", "filecast", "smartfile", "filesun",
  ];

  /*
   * 예비 후보.
   *
   * true 로 두면 그 회차부터 추첨에 들어가고, false 로 바꾸면 빠집니다.
   * 아래 PROVIDERS 의 소개 문구와 webhard.html 의 카드·비교표 행은
   * 꺼 둔 동안에도 그대로 남으므로, 스위치만 도로 켜면 됩니다.
   *
   * 지금은 상시 후보가 9곳이라 둘 다 켜야 10위까지 채워집니다.
   * 하나라도 끄면 노출 수가 그만큼 줄어듭니다(아래 DISPLAY_LIMIT 참고).
   */
  const RESERVE = {
    fileis: true,
    filecookie: true,
    bigfile: true,
    megafile: true,
    pdpop: true,
  };

  const ALL = [
    ...ACTIVE,
    ...Object.keys(RESERVE).filter((id) => RESERVE[id]),
  ];

  const PROVIDERS = {
    ondisk: {
      id: "ondisk",
      name: "온디스크",
      description: "다양한 장르·폭넓은 콘텐츠",
      logo: "ondisk.svg",
      url: "go/ondisk/",
    },
    kdisk: {
      id: "kdisk",
      name: "케이디스크",
      description: "PC·모바일 감상과 다운로드",
      logo: "kdisk.svg",
      url: "go/kdisk/",
    },
    wedisk: {
      id: "wedisk",
      name: "위디스크",
      description: "찜·다시보기와 화면 전송",
      logo: "wedisk.png",
      url: "https://www.wedisk.co.kr/",
    },
    filejo: {
      id: "filejo",
      name: "파일조",
      description: "인기 TOP100으로 콘텐츠 탐색",
      logo: "filejo.gif",
      url: "https://www.filejo.com/main/",
    },
    filenori: {
      id: "filenori",
      name: "파일노리",
      description: "모바일 탐색과 전용 플레이어",
      logo: "filenori.svg",
      url: "https://www.filenori.com/",
    },
    me2disk: {
      id: "me2disk",
      name: "미투디스크",
      description: "다양한 자료와 고객지원",
      logo: "me2disk.jpg",
      url: "https://me2disk.com/",
    },
    filecast: {
      id: "filecast",
      name: "파일캐스트",
      description: "모바일 감상·정액관 이용",
      logo: "filecast.png",
      url: "https://filecast.co.kr/",
    },
    smartfile: {
      id: "smartfile",
      name: "스마트파일",
      description: "화질을 골라 바로보기",
      logo: "smartfile.png",
      url: "https://smartfile.co.kr/",
    },
    filesun: {
      id: "filesun",
      name: "파일썬",
      description: "다양한 장르·출석 이벤트",
      logo: "filesun.png",
      url: "https://www.filesun.com/",
    },

    /*
     * ── 예비 후보 ────────────────────────────────────────────────
     * 아래 두 곳은 RESERVE 스위치로 넣었다 뺐다 합니다.
     * description 은 공식 안내에서 확인한 내용으로 바꿔 주세요.
     * 지금 값은 서비스 종류만 말하는 최소 문구입니다.
     */
    fileis: {
      id: "fileis",
      name: "파일이즈",
      description: "PC·모바일 자료 이용",
      logo: "fileis.svg",
      url: "https://www.fileis.com/",
    },
    filecookie: {
      id: "filecookie",
      name: "파일쿠키",
      description: "PC·모바일 자료 이용",
      logo: "filecookie.svg",
      url: "https://www.filekuki.com/",
    },
    bigfile: {
      id: "bigfile",
      name: "빅파일",
      description: "실시간 TOP100 · 다양한 콘텐츠",
      logo: "bigfile.svg",
      url: "https://bigfile.co.kr/",
    },
    megafile: {
      id: "megafile",
      name: "메가파일",
      description: "PC·모바일 자료 이용",
      logo: "megafile.svg",
      url: "https://www.megafile.co.kr/",
    },
    pdpop: {
      id: "pdpop",
      name: "피디팝",
      description: "인기콘텐츠 · 전용 프로그램",
      logo: "pdpop.svg",
      url: "https://pdpop.co.kr/",
    },
  };

  /*
   * 한 회차에 보여 줄 곳의 수.
   *
   * 후보가 10곳보다 적으면(예비를 둘 다 꺼 둔 경우) 있는 만큼만
   * 보여 줍니다. 10 으로 못 박아 두면 빈 자리가 생깁니다.
   */
  const DISPLAY_LIMIT = Math.min(10, ALL.length);
  const TOP4_ELIGIBLE = ALL.filter((id) => id !== "pdpop");
  const SLOT_HOURS = 3;
  const SLOT_MS = SLOT_HOURS * 60 * 60 * 1000;
  const KST_MS = 9 * 60 * 60 * 1000;

  function hash32(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  function shuffle(list, rng) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /*
   * 사용자가 정한 확률 규칙을 동시에 만족시키기 위해 2위를 먼저 뽑습니다.
   *
   * - 2위: 온디스크/케이디스크/파일조/위디스크/파일노리 각 20%
   * - 2위가 도전자 3사면 1위는 온/케이 중 1곳
   * - 2위가 온/케이면:
   *     1위는 25% 확률로 도전자 3사, 75% 확률로 나머지 온/케이
   *
   * 이러면 전체적으로 1위는 온/케이 90%(각 45%),
   * 파일조/위디스크/파일노리 10%(각 약 3.33%)가 됩니다.
   */
  function buildOrder(slot) {
    const rng = mulberry32(hash32(`ottbora-webhard-${slot}`));
    const order = [];

    const second = pick([...PRIMARY, ...CHALLENGERS], rng);
    let first;

    if (CHALLENGERS.includes(second)) {
      first = pick(PRIMARY, rng);
    } else if (rng() < 0.25) {
      first = pick(CHALLENGERS, rng);
    } else {
      first = PRIMARY.find((id) => id !== second);
    }

    order.push(first, second);

    // 2위가 도전자 3사면 3위는 아직 나오지 않은 온/케이.
    if (CHALLENGERS.includes(second)) {
      const missingPrimary = PRIMARY.filter((id) => !order.includes(id));
      order.push(pick(missingPrimary, rng));
    } else {
      order.push(
        pick(TOP4_ELIGIBLE.filter((id) => !order.includes(id)), rng),
      );
    }

    // 온디스크·케이디스크는 둘 다 4위 안에 있도록 보장합니다.
    const missingPrimary = PRIMARY.filter((id) => !order.includes(id));
    if (missingPrimary.length) {
      order.push(pick(missingPrimary, rng));
    } else {
      order.push(
        pick(TOP4_ELIGIBLE.filter((id) => !order.includes(id)), rng),
      );
    }

    const rest = shuffle(
      ALL.filter((id) => !order.includes(id)),
      rng,
    );

    return [...order, ...rest];
  }

  function getSlot(now = Date.now()) {
    return Math.floor((now + KST_MS) / SLOT_MS);
  }

  function positionMap(order) {
    return new Map(order.map((id, index) => [id, index + 1]));
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function slotHour(slot) {
    const pseudoKst = new Date(slot * SLOT_MS);
    return `${String(pseudoKst.getUTCHours()).padStart(2, "0")}:00`;
  }

  function snapshot(now = Date.now()) {
    const slot = getSlot(now);
    const order = buildOrder(slot);
    const previous = buildOrder(slot - 1);
    const prev = positionMap(previous);
    const previousVisible = new Set(previous.slice(0, DISPLAY_LIMIT));
    const nextRealMs = (slot + 1) * SLOT_MS - KST_MS;

    const visible = order.slice(0, DISPLAY_LIMIT);
    const items = visible.map((id, index) => {
      const position = index + 1;
      const previousPosition = prev.get(id) || position;
      const isNew = !previousVisible.has(id);
      return {
        ...PROVIDERS[id],
        position,
        previousPosition,
        delta: previousPosition - position,
        isNew,
      };
    });

    const summary = items.reduce(
      (acc, item) => {
        if (item.isNew) acc.new += 1;
        else if (item.delta > 0) acc.up += 1;
        else if (item.delta < 0) acc.down += 1;
        else acc.same += 1;
        return acc;
      },
      { up: 0, down: 0, same: 0, new: 0 },
    );

    return {
      slot,
      startLabel: slotHour(slot),
      nextLabel: slotHour(slot + 1),
      remainingMs: nextRealMs - now,
      remainingLabel: formatClock(nextRealMs - now),
      fullOrder: [...order],
      summary,
      order: items,
    };
  }

  function deltaText(delta, isNew = false) {
    if (isNew) return "NEW";
    if (delta > 0) return `▲${delta}`;
    if (delta < 0) return `▼${Math.abs(delta)}`;
    return "–";
  }

  function deltaClass(delta, isNew = false) {
    if (isNew) return "is-new";
    if (delta > 0) return "is-up";
    if (delta < 0) return "is-down";
    return "is-same";
  }

  function watch(callback) {
    let lastSlot = null;

    const tick = () => {
      const data = snapshot();
      const changed = data.slot !== lastSlot;
      lastSlot = data.slot;
      callback(data, changed);
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }

  window.OTT_WEBHARD_RANKING = {
    providers: PROVIDERS,
    allIds: [...ALL],
    displayLimit: DISPLAY_LIMIT,
    buildOrder,
    snapshot,
    watch,
    deltaText,
    deltaClass,
  };
})();
