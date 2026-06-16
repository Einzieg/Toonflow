export default function replaceUrl(url: string): string {
  if (typeof url !== "string" || !url.trim()) return "";

  let pathname = url.trim();
  try {
    pathname = new URL(pathname, "http://toonflow.local").pathname;
  } catch {
    // 非 URL 字符串按本地 OSS 路径处理。
  }

  let cleanedPath = decodeURIComponent(pathname).replace(/\\/g, "/").replace(/^\/+/, "");
  while (/^(oss-preview|oss|smallImage)\//.test(cleanedPath)) {
    cleanedPath = cleanedPath.replace(/^(oss-preview|oss|smallImage)\//, "");
  }

  return cleanedPath ? `/${cleanedPath}` : "";
}
