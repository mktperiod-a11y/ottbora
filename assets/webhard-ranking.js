(() => {
  "use strict";

  const PRIMARY = ["ondisk", "kdisk"];
  const CHALLENGERS = ["filejo", "wedisk", "filenori"];

  const ACTIVE = [
    "ondisk", "kdisk", "wedisk", "filejo", "filenori",
    "filebogo", "applefile", "filestar", "filesun",
  ];

  const RESERVE = {
    yesfile: true,
    filecookie: true,
    bigfile: true,
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
      logo: "logos/ondisk.png",
      logoK: 0.611,
      url: "go/ondisk/",
      home: "https://ondisk.co.kr/",
    },
    kdisk: {
      id: "kdisk",
      name: "케이디스크",
      description: "PC·모바일 감상과 다운로드",
      logo: "logos/kdisk.png",
      logoK: 0.53,
      url: "go/kdisk/",
      home: "https://kdisk.co.kr/",
    },
    wedisk: {
      id: "wedisk",
      name: "위디스크",
      description: "찜·다시보기와 화면 전송",
      logo: "logos/wedisk.png",
      logoK: 0.617,
      url: "go/wedisk/",
      home: "https://www.wedisk.co.kr/",
    },
    filejo: {
      id: "filejo",
      name: "파일조",
      description: "인기 TOP100으로 콘텐츠 탐색",
      logo: "logos/filejo.png",
      logoK: 0.515,
      url: "go/filejo/",
      home: "https://www.filejo.com/main/",
    },
    filenori: {
      id: "filenori",
      name: "파일노리",
      description: "모바일 탐색과 전용 플레이어",
      logo: "logos/filenori.png",
      logoK: 0.49,
      url: "go/filenori/",
      home: "https://www.filenori.com/",
    },
    filebogo: {
      id: "filebogo",
      name: "파일보고",
      description: "실시간 인기·장르별 탐색",
      logo: "logos/filebogo.png",
      logoK: 0.6,
      url: "go/filebogo/",
      home: "https://www.filebogo.com/",
    },
    applefile: {
      id: "applefile",
      name: "애플파일",
      description: "통합검색·정액제 이용",
      logo: "logos/applefile.png",
      logoK: 0.6,
      url: "go/applefile/",
      home: "https://www.applefile.com/",
    },
    filestar: {
      id: "filestar",
      name: "파일스타",
      description: "실시간 스트리밍·모바일 전용 플레이어",
      logo: "logos/filestar.png",
      logoK: 0.436,
      url: "go/filestar/",
      home: "https://filestar.co.kr/",
    },
    filesun: {
      id: "filesun",
      name: "파일썬",
      description: "다양한 장르·출석 이벤트",
      logo: "logos/filesun.png",
      logoK: 0.519,
      url: "go/filesun/",
      home: "https://www.filesun.com/",
    },

    yesfile: {
      id: "yesfile",
      name: "예스파일",
      description: "실시간 인기·정액제 이용",
      logo: "logos/yesfile.png",
      logoK: 0.6,
      url: "go/yesfile/",
      home: "https://www.yesfile.com/",
    },
    filecookie: {
      id: "filecookie",
      name: "파일쿠키",
      description: "PC 구매 후 모바일 재생",
      logo: "logos/filecookie.png",
      logoK: 0.458,
      url: "go/filecookie/",
      home: "https://www.filekuki.com/",
    },
    bigfile: {
      id: "bigfile",
      name: "빅파일",
      description: "실시간 TOP100 · 다양한 콘텐츠",
      logo: "logos/bigfile.png",
      logoK: 0.588,
      url: "go/bigfile/",
      home: "https://bigfile.co.kr/",
    },
    pdpop: {
      id: "pdpop",
      name: "피디팝",
      description: "인기콘텐츠 · 전용 프로그램",
      logo: "logos/pdpop.png",
      logoK: 0.547,
      url: "go/pdpop/",
      home: "https://new.pdpop.com/",
    },
  };

  const DISPLAY_LIMIT = Math.min(10, ALL.length);
  const TOP4_ELIGIBLE = ALL.filter((id) => id !== "pdpop");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SLOT_MS = 7 * DAY_MS;
  const WEEK_OFFSET_MS = 4 * DAY_MS;
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

    if (CHALLENGERS.includes(second)) {
      const missingPrimary = PRIMARY.filter((id) => !order.includes(id));
      order.push(pick(missingPrimary, rng));
    } else {
      order.push(
        pick(TOP4_ELIGIBLE.filter((id) => !order.includes(id)), rng),
      );
    }

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
    return Math.floor((now + KST_MS - WEEK_OFFSET_MS) / SLOT_MS);
  }

  function positionMap(order) {
    return new Map(order.map((id, index) => [id, index + 1]));
  }

  function slotStartLabel(slot) {
    const kst = new Date(slot * SLOT_MS + WEEK_OFFSET_MS);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${kst.getUTCFullYear()}.${pad(kst.getUTCMonth() + 1)}.${pad(kst.getUTCDate())} ` +
      `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`
    );
  }

  function snapshot(now = Date.now()) {
    const slot = getSlot(now);
    const order = buildOrder(slot);
    const previous = buildOrder(slot - 1);
    const prev = positionMap(previous);
    const previousVisible = new Set(previous.slice(0, DISPLAY_LIMIT));

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
      updatedLabel: slotStartLabel(slot),
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
    const timer = setInterval(tick, 30 * 1000);
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
