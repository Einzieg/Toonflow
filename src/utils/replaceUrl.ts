import oss from "@/utils/oss";

function getCosPrefixCandidates(): string[] {
  const envPrefix = String(process.env.OSS_COS_PATH_PREFIX || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return [...new Set([envPrefix, "toonflow"].filter(Boolean))];
}

function stripLeadingCosPrefixes(segments: string[]): string[] {
  const prefixes = getCosPrefixCandidates();
  while (segments[0] && prefixes.includes(segments[0])) {
    segments.shift();
  }
  return segments;
}

function normalizeSegments(pathname: string): string[] {
  const segments = pathname
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const lastOssIndex = segments.lastIndexOf("oss");
  const effectiveSegments = lastOssIndex >= 0 ? segments.slice(lastOssIndex + 1) : segments;

  return stripLeadingCosPrefixes(effectiveSegments);
}

export default function replaceUrl(url: string): string {
  if (typeof url !== "string" || !url.trim()) return "";

  const rawUrl = url.trim();
  const localPath = oss.getLocalPathFromPublicUrl(rawUrl);
  if (localPath === "") {
    return "";
  }

  let pathname = localPath ?? rawUrl;
  if (localPath === null) {
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      pathname = rawUrl;
    }
  }

  const normalizedSegments = normalizeSegments(pathname.split("?")[0].split("#")[0]);
  return normalizedSegments.length ? `/${normalizedSegments.join("/")}` : "";
}
