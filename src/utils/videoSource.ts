import oss from "@/utils/oss";

export const REMOTE_VIDEO_URL_TTL_MS = 23 * 60 * 60 * 1000;

function normalizeBaseUrl(value?: string | null) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getHeader(req: any, name: string) {
  const value = typeof req?.get === "function" ? req.get(name) : req?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function isLocalHost(host: string) {
  return /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)(:|$)/i.test(host);
}

function getHeaderOrigin(req: any, name: string) {
  const value = getHeader(req, name);
  if (!value) return "";
  try {
    const url = new URL(value);
    return normalizeBaseUrl(url.origin);
  } catch {
    return "";
  }
}

export function getRequestPublicBaseUrl(req?: any) {
  const configured = normalizeBaseUrl(process.env.OSS_PUBLIC_BASE_URL || process.env.OSSURL || process.env.ossURL);
  if (configured) return configured;

  const origin = getHeaderOrigin(req, "origin") || getHeaderOrigin(req, "referer");
  if (origin) {
    try {
      const host = new URL(origin).host;
      if (!isLocalHost(host)) return origin;
    } catch {}
  }

  const forwardedHost = getHeader(req, "x-forwarded-host").split(",")[0].trim();
  const host = forwardedHost || getHeader(req, "host").split(",")[0].trim();
  if (!host) return "";

  const forwardedProto = getHeader(req, "x-forwarded-proto").split(",")[0].trim();
  const proto = forwardedProto || (isLocalHost(host) ? req?.protocol || "http" : "https");
  return `${proto}://${host}`;
}

export async function getPublicOssFileUrl(filePath: string, req?: any) {
  const publicUrl = await oss.getFileUrl(filePath);
  if (/^https?:\/\//i.test(publicUrl)) return publicUrl;

  const baseUrl = getRequestPublicBaseUrl(req);
  if (!baseUrl) return publicUrl;
  return `${baseUrl}${publicUrl.startsWith("/") ? "" : "/"}${publicUrl}`;
}

export function normalizeVideoState(state?: string | null) {
  if (state === "已完成" || state === "生成成功") return "已完成";
  if (state === "生成中") return "生成中";
  if (state === "生成失败") return "生成失败";
  return "未生成";
}

export interface RenderableVideoSource {
  filePath?: string | null;
  state?: string | null;
  remoteUrl?: string | null;
  remoteUrlExpireTime?: number | string | null;
  localSaveState?: string | null;
}

export async function getRenderableVideoSrc(source: RenderableVideoSource) {
  if (normalizeVideoState(source.state) !== "已完成") return "";

  const remoteUrl = String(source.remoteUrl || "").trim();
  const remoteUrlExpireTime = Number(source.remoteUrlExpireTime || 0);
  if (remoteUrl && remoteUrlExpireTime > Date.now()) return remoteUrl;

  const filePath = String(source.filePath || "").trim();
  if (!filePath) return "";

  // 新生成的视频只有本地保存完成后才回退本地地址；历史数据没有该字段，按文件存在性兼容。
  const shouldUseLocal = source.localSaveState === "已保存" || !source.localSaveState;
  if (!shouldUseLocal || !(await oss.fileExists(filePath))) return "";

  return oss.getFileUrl(filePath);
}
