export function normalizeStoryboardText(value?: string | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function isSilentStoryboardDialogue(value?: string | null) {
  const text = normalizeStoryboardText(value);
  return !text || /^无(?:台词|对白|配音|旁白|OS|VO)?[。.!！]?$/i.test(text);
}

export function countStoryboardDialogueChars(value?: string | null) {
  const text = normalizeStoryboardText(value);
  if (isSilentStoryboardDialogue(text)) return 0;
  return text
    .replace(/(?:^|[；;。.!！?？])[^；;。.!！?？：:]{1,16}[：:]/g, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
}

export function extractStoryboardDialogueFromVideoDesc(videoDesc?: string | null) {
  const text = normalizeStoryboardText(videoDesc);
  const markedMatch = text.match(/(?:【台词】|台词[：:])\s*(.*?)(?=(?:【音效】|音效[：:]|【关联资产ID】|关联资产(?:ID)?[：:]|$))/);
  const dialogue = normalizeStoryboardText(markedMatch?.[1] || "");
  return isSilentStoryboardDialogue(dialogue) ? "" : dialogue.replace(/[。；;]\s*$/, "");
}

export function normalizeStoryboardShotMeta(
  value: Record<string, any> | null | undefined,
  input: {
    dialogue?: string | null;
    videoDesc?: string | null;
    duration?: number | string | null;
    sourceShotNo?: number | string | null;
  } = {},
) {
  const dialogue = normalizeStoryboardText(input.dialogue) || extractStoryboardDialogueFromVideoDesc(input.videoDesc);
  const computedCharCount = countStoryboardDialogueChars(dialogue);
  const meta = value && typeof value === "object" ? { ...value } : {};
  const rawDurationReason = normalizeStoryboardText(meta.durationReason);
  const reasonContradictsDialogue =
    computedCharCount > 0 &&
    (/无(?:台词|对白|配音|旁白|OS|VO)/i.test(rawDurationReason) || /(?:^|[^0-9])0\s*字/.test(rawDurationReason));

  return {
    ...meta,
    ...(input.sourceShotNo != null && meta.sourceShotNo == null ? { sourceShotNo: input.sourceShotNo } : {}),
    dialogueCharCount: computedCharCount,
    estimatedSpeechRate: meta.estimatedSpeechRate ?? null,
    estimatedSpeechDuration: meta.estimatedSpeechDuration ?? null,
    durationReason: reasonContradictsDialogue
      ? `含台词 ${computedCharCount} 字；原 Agent 时长依据与最终台词不一致，已按最终台词校准字数。`
      : rawDurationReason,
    durationReasonSource: reasonContradictsDialogue ? "corrected" : meta.durationReasonSource ?? "unknown",
  };
}
