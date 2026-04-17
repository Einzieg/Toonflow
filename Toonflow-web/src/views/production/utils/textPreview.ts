export function buildTextPreview(value: string | null | undefined, options?: { maxLength?: number; maxLines?: number }): string {
  const normalized = String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ")
    .trim();

  if (!normalized) return "";

  const maxLines = Math.max(1, Number(options?.maxLines || 0) || 18);
  const maxLength = Math.max(1, Number(options?.maxLength || 0) || 1200);
  const lines = normalized.split("\n").slice(0, maxLines);
  let preview = lines.join("\n");

  if (preview.length > maxLength) {
    preview = `${preview.slice(0, maxLength).trimEnd()}...`;
  } else if (lines.length < normalized.split("\n").length) {
    preview = `${preview.trimEnd()}\n...`;
  }

  return preview;
}
