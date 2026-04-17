const PROCESSABLE_IMAGE_EXT_RE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const TENCENT_COS_HOST_RE = /(^|\.)cos\.[^.]+\.myqcloud\.com$/i;

interface PreviewOptions {
  width?: number;
  height?: number;
  format?: "webp" | "jpeg" | "png";
}

function isProcessableTencentCosUrl(url: string) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (!TENCENT_COS_HOST_RE.test(parsed.hostname)) return false;
    return PROCESSABLE_IMAGE_EXT_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function buildTencentCosPreviewUrl(publicUrl?: string | null, options?: PreviewOptions) {
  if (!publicUrl) return "";
  if (publicUrl.includes("imageView2/") || publicUrl.includes("imageMogr2/")) return publicUrl;
  if (!isProcessableTencentCosUrl(publicUrl)) return publicUrl;

  const width = Math.max(0, Math.round(Number(options?.width || 0)));
  const height = Math.max(0, Math.round(Number(options?.height || 0)));
  const format = options?.format || "webp";
  const processSegments = ["imageView2", "1"];

  if (width > 0) processSegments.push("w", String(width));
  if (height > 0) processSegments.push("h", String(height));
  if (format) processSegments.push("format", format);

  const separator = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${separator}${processSegments.join("/")}`;
}

export function getPreviewImageSrc(thumbSrc?: string | null, src?: string | null, options?: PreviewOptions) {
  if (thumbSrc) return thumbSrc;
  if (!src) return "";
  return buildTencentCosPreviewUrl(src, options) || src;
}
