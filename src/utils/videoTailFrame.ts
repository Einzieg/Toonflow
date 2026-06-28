import axios from "axios";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import u from "@/utils";
import { normalizeVideoState } from "@/utils/videoSource";

const execFileAsync = promisify(execFile);

type VideoRow = {
  id?: number | null;
  projectId?: number | null;
  scriptId?: number | null;
  videoTrackId?: number | null;
  filePath?: string | null;
  remoteUrl?: string | null;
  remoteUrlExpireTime?: number | string | null;
  state?: string | null;
};

type TailFrameResult = {
  videoId: number;
  filePath: string;
  src: string;
};

function resolveFfmpegPath() {
  const configured = String(process.env.FFMPEG_PATH || "").trim();
  if (configured) return configured;

  const bundled = path.join(__dirname, "ffmpeg");
  return bundled || "ffmpeg";
}

export function getVideoTailFramePath(videoId: number, projectId: number) {
  return `/${projectId}/videoTailFrames/${videoId}.jpg`;
}

async function fileExists(absPath: string) {
  try {
    const stat = await fs.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function getFfmpegBinary() {
  const configured = resolveFfmpegPath();
  if (configured && configured !== "ffmpeg" && (await fileExists(configured))) return configured;

  try {
    const ffmpegStaticPath = require("ffmpeg-static");
    if (ffmpegStaticPath && (await fileExists(ffmpegStaticPath))) return ffmpegStaticPath;
  } catch {}

  return "ffmpeg";
}

async function downloadRemoteVideo(url: string, targetPath: string) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    const body = Buffer.from(response.data || "").toString("utf8").slice(0, 300);
    throw new Error(`下载视频失败，状态码: ${response.status}, 响应: ${body}`);
  }
  await fs.writeFile(targetPath, Buffer.from(response.data));
}

async function resolveVideoInputPath(video: VideoRow) {
  const localPath = String(video.filePath || "").trim();
  if (localPath && !/^https?:\/\//i.test(localPath) && (await u.oss.fileExists(localPath))) {
    return {
      inputPath: u.oss.resolveLocalAbsolutePath(localPath),
      cleanup: async () => {},
    };
  }

  const remoteUrl = String(video.remoteUrl || (localPath.match(/^https?:\/\//i) ? localPath : "")).trim();
  const remoteUrlExpireTime = Number(video.remoteUrlExpireTime || 0);
  if (!remoteUrl || (remoteUrlExpireTime > 0 && remoteUrlExpireTime <= Date.now())) {
    throw new Error("视频本地文件不可用，且远程链接不存在或已过期");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-tail-frame-"));
  const tempVideoPath = path.join(tempDir, "input.mp4");
  await downloadRemoteVideo(remoteUrl, tempVideoPath);
  return {
    inputPath: tempVideoPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function extractTailFrame(inputPath: string, outputPath: string) {
  const ffmpeg = await getFfmpegBinary();
  const attempts = [
    ["-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.08", "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath],
    ["-y", "-hide_banner", "-loglevel", "error", "-sseof", "-0.5", "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath],
  ];
  let lastError: unknown = null;
  for (const args of attempts) {
    try {
      await execFileAsync(ffmpeg, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
      if (await fileExists(outputPath)) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`视频尾帧抽取失败：${u.error(lastError).message || "ffmpeg 执行失败"}`);
}

export async function ensureVideoTailFrame(video: VideoRow, req?: any): Promise<TailFrameResult> {
  const videoId = Number(video.id);
  const projectId = Number(video.projectId);
  if (!Number.isInteger(videoId) || videoId <= 0) throw new Error("缺少视频 ID");
  if (!Number.isInteger(projectId) || projectId <= 0) throw new Error("缺少项目 ID");
  if (normalizeVideoState(video.state) !== "已完成") throw new Error("视频尚未生成完成");

  const framePath = getVideoTailFramePath(videoId, projectId);
  if (!(await u.oss.fileExists(framePath))) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "toonflow-tail-frame-out-"));
    const tempFramePath = path.join(tempDir, "tail.jpg");
    const input = await resolveVideoInputPath(video);
    try {
      await extractTailFrame(input.inputPath, tempFramePath);
      await u.oss.writeFile(framePath, await fs.readFile(tempFramePath));
    } finally {
      await input.cleanup();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    videoId,
    filePath: framePath,
    src: await u.oss.getFileUrl(framePath),
  };
}

async function findCompletedVideoByTrackId(trackId: number) {
  const track = await u.db("o_videoTrack").where("id", trackId).select("id", "videoId", "selectVideoId").first();
  const preferredId = Number(track?.videoId || track?.selectVideoId || 0);
  if (Number.isInteger(preferredId) && preferredId > 0) {
    const selectedVideo = await u.db("o_video").where("id", preferredId).first();
    if (selectedVideo && normalizeVideoState(selectedVideo.state) === "已完成") return selectedVideo;
  }

  return u
    .db("o_video")
    .where("videoTrackId", trackId)
    .whereIn("state", ["已完成", "生成成功"])
    .orderBy("time", "desc")
    .first();
}

export async function ensureTrackSelectedVideoTailFrame(trackId: number, req?: any) {
  const video = await findCompletedVideoByTrackId(trackId);
  if (!video) throw new Error("上一分镜没有已完成的视频");
  return ensureVideoTailFrame(video, req);
}

export async function ensureVideoTailFrameById(videoId: number, req?: any) {
  const video = await u.db("o_video").where("id", videoId).first();
  if (!video) throw new Error("视频不存在");
  return ensureVideoTailFrame(video, req);
}

export async function ensurePreviousStoryboardTailFrame(storyboard: { id?: number | null; projectId?: number | null; scriptId?: number | null; index?: number | null; trackId?: number | null }, req?: any) {
  const projectId = Number(storyboard.projectId);
  const scriptId = Number(storyboard.scriptId);
  const storyboardIndex = Number(storyboard.index);
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId) || !Number.isFinite(storyboardIndex)) {
    throw new Error("分镜缺少项目、分集或序号");
  }

  const previousStoryboard = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .where("index", "<", storyboardIndex)
    .whereNotNull("trackId")
    .orderBy("index", "desc")
    .first();
  if (!previousStoryboard?.trackId) throw new Error("没有上一分镜视频轨道");

  return ensureTrackSelectedVideoTailFrame(Number(previousStoryboard.trackId), req);
}

export async function ensurePreviousVideoTrackTailFrame(input: { projectId: number; scriptId: number; trackId: number }, req?: any) {
  const projectId = Number(input.projectId);
  const scriptId = Number(input.scriptId);
  const trackId = Number(input.trackId);
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId) || !Number.isInteger(trackId)) {
    throw new Error("缺少项目、分集或视频轨道 ID");
  }

  const currentFirstStoryboard = await u
    .db("o_storyboard")
    .where({ projectId, scriptId, trackId })
    .orderBy("index", "asc")
    .first();
  if (!currentFirstStoryboard || currentFirstStoryboard.index == null) throw new Error("当前轨道没有关联分镜");

  const previousStoryboard = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .where("index", "<", Number(currentFirstStoryboard.index))
    .whereNotNull("trackId")
    .orderBy("index", "desc")
    .first();
  if (!previousStoryboard?.trackId) throw new Error("没有上一分镜视频轨道");

  return ensureTrackSelectedVideoTailFrame(Number(previousStoryboard.trackId), req);
}
