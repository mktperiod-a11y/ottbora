/**
 * 포스터 이미지를 받아 저장소에 넣습니다.
 *
 * 박스오피스(fetch-posters)와 애니(fetch-anime)가 같은 처리를 쓰므로
 * 여기 한 곳에 둡니다. 두 곳에 복사해 두면 고칠 때 한쪽을 빠뜨립니다.
 */

import { writeFile } from "node:fs/promises";
import sharp from "sharp";

/** 카드에 쓰는 크기. 2:3 은 포스터 표준 비율입니다. */
export const W = 400;
export const H = 600;

/** 한 장이 이보다 크면 받지 않습니다. 포스터가 이럴 일은 없습니다. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * 이미지를 받아 2:3 webp 로 저장합니다.
 *
 * 포스터는 API 와 다른 호스트에 있는 경우가 많습니다. 그런 호스트는
 * 브라우저가 아닌 요청을 거절할 수 있어, 평범한 브라우저처럼 보이는
 * 헤더를 붙입니다. 거절되면 예외를 던지고 부르는 쪽이 그 작품만 건너뜁니다.
 *
 * 한 번 받아 저장소에 넣으므로 방문자 브라우저는 이 호스트에 붙지 않습니다.
 * 상대가 나중에 핫링크를 막아도 이미 받아 둔 이미지는 그대로 뜹니다.
 */
export async function savePoster(url, file, referer) {
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

/**
 * 연결이 실패하거나 느릴 때가 있어 몇 번 다시 시도합니다.
 * 보조 정보라 오래 매달리지 않습니다.
 */
export async function getJson(
  url,
  label,
  { attempts = 2, timeout = 10000, backoffMs = 2000 } = {},
) {
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
      const why = e?.cause?.code || e?.message;
      if (i < attempts) {
        console.warn(`  ${label} 실패 (${i}/${attempts}): ${why} — 다시 시도`);
        await new Promise((r) => setTimeout(r, i * backoffMs));
      }
    }
  }
  throw new Error(`${label}: ${last?.cause?.code || last?.message}`);
}

/**
 * GraphQL 용. getJson 과 같은 재시도·시간초과 규칙을 씁니다.
 * 요청이 POST 이고 본문이 있다는 점만 다릅니다.
 */
export async function postJson(
  url,
  body,
  label,
  { attempts = 2, timeout = 10000, backoffMs = 2000 } = {},
) {
  let last;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // GraphQL 은 HTTP 200 으로 오류를 돌려주기도 합니다.
      if (json?.errors?.length) {
        throw new Error(json.errors[0]?.message || "GraphQL 오류");
      }
      return json;
    } catch (e) {
      last = e;
      const why = e?.cause?.code || e?.message;
      if (i < attempts) {
        console.warn(`  ${label} 실패 (${i}/${attempts}): ${why} — 다시 시도`);
        await new Promise((r) => setTimeout(r, i * backoffMs));
      }
    }
  }
  throw new Error(`${label}: ${last?.cause?.code || last?.message}`);
}

/** 제목 비교용. 공백·문장부호를 떼고 맞춥니다. */
export const norm = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");

/** "2026-09-16" 또는 "20260916" → "2026" */
export const yearOf = (s) => String(s || "").slice(0, 4);
