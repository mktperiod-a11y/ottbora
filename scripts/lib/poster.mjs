
import { writeFile } from "node:fs/promises";
import sharp from "sharp";

export const W = 400;
export const H = 600;

const MAX_BYTES = 12 * 1024 * 1024;

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

export const norm = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");

export const yearOf = (s) => String(s || "").slice(0, 4);
