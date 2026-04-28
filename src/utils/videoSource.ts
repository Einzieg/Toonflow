import oss from "@/utils/oss";

export const REMOTE_VIDEO_URL_TTL_MS = 23 * 60 * 60 * 1000;

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
