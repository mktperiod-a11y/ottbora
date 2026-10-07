
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

const SYSTEM = `너는 한국어 애니메이션 정보 사이트의 번역가다. 사용자가 주는 영어 애니메이션 줄거리를 자연스러운 한국어로 옮긴다.

- 국내에 정식으로 소개된 작품명·인물명·지명 표기를 알면 그것을 따른다. 확실하지 않으면 원어(대개 일본어) 발음대로 옮기고, 일본 인명은 성·이름 순으로 쓴다(예: Yuusuke Tani → 타니 유스케). 이름을 새로 지어내지 않는다.
- 원문에 있는 내용만 옮긴다. 설명, 평가, 홍보 문구를 더하지 않고, 원문의 내용을 빼지도 않는다.
- 문단 나눔은 원문을 따른다.
- 문체는 줄거리 소개에 흔한 담백한 서술체(…한다, …이다)로 쓴다.
- 번역문만 출력한다. 제목, 머리말, 따옴표, 태그, 부연 설명을 붙이지 않는다.`;

const TITLE_SYSTEM = `너는 한국어 애니메이션 정보 사이트의 작품명 번역가다. 영어 제목과 일본어 원제를 보고 한국어 제목 한 줄만 출력한다.

- 널리 알려진 국내 공식 제목이 확실하면 그 표기를 따른다. 확실하지 않으면 원문의 뜻을 자연스럽게 옮기거나 고유명사를 발음대로 적는다. 공식 제목이라고 추측해 꾸며 내지 않는다.
- 원문에 있는 시즌·기수·파트·숫자를 빠뜨리지 않는다. 제목에 없는 정보를 덧붙이지 않는다.
- 한국어 제목 한 줄만 출력한다. 머리말, 설명, 따옴표, 괄호 속 원제, 마크다운을 붙이지 않는다.`;

export const translatorReady = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;

export async function translateTitle({ title, original }) {
  client ??= new Anthropic({ maxRetries: 4, timeout: 120_000 });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 256,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: TITLE_SYSTEM,
    messages: [
      { role: "user", content: `영어 제목: ${title}\n일본어 원제: ${original || "없음"}` },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("제목 번역을 거절함(refusal)");
  if (response.stop_reason === "max_tokens") throw new Error("제목 번역이 잘림(max_tokens)");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function translateSynopsis({ text, title, original }) {
  client ??= new Anthropic({ maxRetries: 4, timeout: 120_000 });
  const about = original && original !== title ? `${title} (원제: ${original})` : title;
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [
      { role: "user", content: `작품: ${about}\n\n<synopsis>\n${text}\n</synopsis>` },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("번역을 거절함(refusal)");
  if (response.stop_reason === "max_tokens") throw new Error("번역이 잘림(max_tokens)");
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/^\s*<synopsis>\s*|\s*<\/synopsis>\s*$/g, "")
    .trim();
}

export function stopsTranslation(e) {
  return (
    e instanceof Anthropic.AuthenticationError ||
    e instanceof Anthropic.PermissionDeniedError ||
    e instanceof Anthropic.RateLimitError
  );
}

export function looksKorean(ko, en) {
  if (!ko) return false;
  const hangul = (ko.match(/[가-힣]/g) || []).length;
  const letters = (ko.match(/\p{L}/gu) || []).length;
  if (hangul < 5 || hangul / letters < 0.5) return false;
  return ko.length >= en.length * 0.15 && ko.length <= Math.max(en.length * 2, 80);
}
