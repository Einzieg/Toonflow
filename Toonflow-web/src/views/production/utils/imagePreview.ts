const PROCESSABLE_IMAGE_EXT_RE = /\.(jpe?g|png|webp|bmp|gif)$/i;
const TENCENT_COS_HOST_RE = /(^|\.)cos\.[^.]+\.myqcloud\.com$/i;
const LOCAL_PREVIEW_PATH_RE = /^\/oss-preview\//i;

interface PreviewOptions {
  width?: number;
  height?: number;
  format?: "webp" | "jpeg" | "png";
}

export function appendCacheBust(url?: string | null, version = Date.now()) {
  if (!url) return "";

  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("_v", String(version));
    if (/^https?:\/\//i.test(url)) return parsed.toString();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const [withoutHash, hash = ""] = String(url).split("#", 2);
    const separator = withoutHash.includes("?") ? "&" : "?";
    return `${withoutHash}${separator}_v=${version}${hash ? `#${hash}` : ""}`;
  }
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

function getLocalOssRelativePath(url: string) {
  if (!url) return "";

  try {
    const parsed = new URL(url, window.location.origin);
    if (!PROCESSABLE_IMAGE_EXT_RE.test(parsed.pathname)) return "";
    if (LOCAL_PREVIEW_PATH_RE.test(parsed.pathname)) return "";
    if (!parsed.pathname.startsWith("/oss/")) return "";
    return parsed.pathname.slice("/oss/".length);
  } catch {
    return "";
  }
}

function encodePathSegments(value: string) {
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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

export function buildLocalPreviewUrl(publicUrl?: string | null, options?: PreviewOptions) {
  if (!publicUrl) return "";
  const relativePath = getLocalOssRelativePath(publicUrl);
  if (!relativePath) return publicUrl;

  const width = Math.max(0, Math.round(Number(options?.width || 0)));
  const height = Math.max(0, Math.round(Number(options?.height || 0)));
  const format = options?.format || "webp";
  const previewPath = `/oss-preview/${encodePathSegments(relativePath)}`;
  const previewUrl = new URL(previewPath, window.location.origin);

  if (width > 0) previewUrl.searchParams.set("w", String(width));
  if (height > 0) previewUrl.searchParams.set("h", String(height));
  if (format) previewUrl.searchParams.set("format", format);

  if (/^https?:\/\//i.test(publicUrl)) return previewUrl.toString();
  return `${previewUrl.pathname}${previewUrl.search}${previewUrl.hash}`;
}

export function getPreviewImageSrc(thumbSrc?: string | null, src?: string | null, options?: PreviewOptions) {
  if (thumbSrc) return thumbSrc;
  if (!src) return "";
  return buildLocalPreviewUrl(src, options) || buildTencentCosPreviewUrl(src, options) || src;
}

export function getVersionedPreviewImageSrc(thumbSrc?: string | null, src?: string | null, options?: PreviewOptions, version = Date.now()) {
  const previewSrc = getPreviewImageSrc(thumbSrc, src, options);
  return appendCacheBust(previewSrc, version);
}
