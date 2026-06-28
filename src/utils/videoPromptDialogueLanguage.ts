function normalizePromptWhitespace(prompt: string) {
  return String(prompt || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeText(value?: string | null) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeText).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function renderMandarinDialogueLanguageRule(requiredLines: string[] = []) {
  const lines = uniqueText(requiredLines);
  return [
    "[Dialogue language rule]",
    "All spoken dialogue, voiceover, narration, OS/VO, dubbing, and lip-synced lines must be Chinese Mandarin only.",
    "English is allowed only for visual, camera, action, performance, lighting, BGM, and technical descriptions; never as spoken words.",
    "Do not invent English spoken lines. Do not translate Chinese dialogue into English.",
    lines.length
      ? ["Required Chinese Mandarin lines to speak verbatim, no subtitles:", ...lines.map((line, index) => `${index + 1}. ${line}`)].join("\n")
      : "No required Chinese dialogue lines were provided; if a character speaks, the spoken text must still be Chinese Mandarin.",
  ].join("\n");
}

export function ensureMandarinDialogueLanguageRule(prompt: string, requiredLines: string[] = []) {
  const normalized = normalizePromptWhitespace(prompt);
  if (!normalized) return renderMandarinDialogueLanguageRule(requiredLines);
  if (/\[Dialogue language rule\]/i.test(normalized)) return normalized;
  return normalizePromptWhitespace([normalized, renderMandarinDialogueLanguageRule(requiredLines)].join("\n\n"));
}
