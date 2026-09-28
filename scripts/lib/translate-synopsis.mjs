/**
 * 영어 애니 줄거리를 한국어로 옮깁니다(Claude API).
 *
 * ANTHROPIC_API_KEY 가 있을 때만 씁니다. 키는 GitHub 저장소의
 * Settings → Secrets and variables → Actions 에 같은 이름으로 넣습니다.
 * 키가 없으면 번역하지 않고, 줄거리는 원문(영어)으로 남습니다.
 *
 * 부르는 쪽(fetch-anime.mjs)이 결과를 assets/anime-synopsis-auto.json 에
 * 모아 두므로, 한 작품은 원문이 바뀌지 않는 한 한 번만 번역합니다.
 */

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

const SYSTEM = `너는 한국어 애니메이션 정보 사이트의 번역가다. 사용자가 주는 영어 애니메이션 줄거리를 자연스러운 한국어로 옮긴다.

- 국내에 정식으로 소개된 작품명·인물명·지명 표기를 알면 그것을 따른다. 확실하지 않으면 원어(대개 일본어) 발음대로 옮기고, 일본 인명은 성·이름 순으로 쓴다(예: Yuusuke Tani → 타니 유스케). 이름을 새로 지어내지 않는다.
- 원문에 있는 내용만 옮긴다. 설명, 평가, 홍보 문구를 더하지 않고, 원문의 내용을 빼지도 않는다.
- 문단 나눔은 원문을 따른다.
- 문체는 줄거리 소개에 흔한 담백한 서술체(…한다, …이다)로 쓴다.
- 번역문만 출력한다. 제목, 머리말, 따옴표, 태그, 부연 설명을 붙이지 않는다.`;

export const translatorReady = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;

/**
 * 한 편을 옮깁니다. 실패하면 던집니다(부르는 쪽이 원문으로 둡니다).
 *
 * 429·5xx(과부하 529 포함)·연결 오류는 SDK 가 알아서 몇 번 더 시도합니다.
 * 안전 분류기가 거절하면 fallbacks: "default" 가 서버에서 다른 모델로
 * 다시 돌리고, 그래도 거절이면 stop_reason 이 "refusal" 로 옵니다.
 */
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

/**
 * 이번 실행에서 더 번역해 봐야 소용없는 실패인지 봅니다.
 * 키가 틀렸거나(401·403), 재시도까지 다 쓴 요청 한도 초과(429)면 멈춥니다.
 */
export function stopsTranslation(e) {
  return (
    e instanceof Anthropic.AuthenticationError ||
    e instanceof Anthropic.PermissionDeniedError ||
    e instanceof Anthropic.RateLimitError
  );
}

/** 번역문이 한국어 줄거리다운지 봅니다. 아니면 원문을 둡니다. */
export function looksKorean(ko, en) {
  if (!ko) return false;
  const hangul = (ko.match(/[가-힣]/g) || []).length;
  const letters = (ko.match(/\p{L}/gu) || []).length;
  if (hangul < 5 || hangul / letters < 0.5) return false;
  // 아주 짧은 원문은 비율이 크게 흔들리므로 위쪽 한계에 여유를 둡니다.
  return ko.length >= en.length * 0.15 && ko.length <= Math.max(en.length * 2, 80);
}
