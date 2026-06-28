import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getRenderableVideoSrc, normalizeVideoState } from "@/utils/videoSource";

const router = express.Router();

function parseStoryboardIds(value?: string | null) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson(value?: string | null, fallback: any = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function buildImageUrls(row: any) {
  const imageUrl = row.filePath ? await u.oss.getFileUrl(row.filePath) : "";
  const thumbUrl = row.thumbPath ? await u.oss.getFileUrl(row.thumbPath) : imageUrl ? u.oss.buildImagePreviewUrl(imageUrl, { width: 640, format: "webp" }) : "";
  return { imageUrl, thumbUrl };
}

async function buildVideoReferenceDebug(row: any) {
  const frameManifest = safeParseJson(row.frameManifest, []);
  const shotTimeline = safeParseJson(row.shotTimeline, []);
  const lockedNarrative = safeParseJson(row.lockedNarrative, null);
  const videoReferenceUrl = row.videoReferencePath ? await u.oss.getFileUrl(row.videoReferencePath) : "";
  const requestImageUrl = videoReferenceUrl;
  const videoReferenceFrames = Array.isArray(frameManifest)
    ? await Promise.all(
        frameManifest.map(async (item: any) => {
          const imageUrl = item?.filePath ? await u.oss.getFileUrl(item.filePath) : "";
          return {
            ...item,
            imageUrl,
            thumbUrl: imageUrl ? u.oss.buildImagePreviewUrl(imageUrl, { width: 360, format: "webp" }) : "",
          };
        }),
      )
    : [];

  return {
    videoReferenceUrl,
    requestImageUrl,
    videoReferenceFrames,
    shotTimelineItems: Array.isArray(shotTimeline) ? shotTimeline : [],
    lockedNarrativeData: lockedNarrative,
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body as { projectId: number; scriptId: number };
    const boards = await u.db("o_storyboardBoard").where({ projectId, scriptId }).orderBy("startIndex", "asc").orderBy("createTime", "asc");
    const boardIds = boards.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
    const boardVideos = boardIds.length
      ? await u.db("o_storyboardBoardVideo").whereIn("boardId", boardIds).orderBy("createTime", "desc")
      : [];
    const latestBoardVideoMap = new Map<number, any>();
    const boardVideoMap = new Map<number, any[]>();
    for (const item of boardVideos) {
      const boardId = Number(item.boardId);
      if (!boardVideoMap.has(boardId)) boardVideoMap.set(boardId, []);
      boardVideoMap.get(boardId)!.push(item);
      if (!latestBoardVideoMap.has(boardId)) latestBoardVideoMap.set(boardId, item);
    }

    const videoIds = boardVideos
      .map((item: any) => Number(item.videoId))
      .filter((id) => Number.isInteger(id) && id > 0);
    const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
    const videoMap = new Map(videos.map((item: any) => [Number(item.id), item]));

    const result = await Promise.all(
      boards.map(async (board: any) => {
        const boardVideo = latestBoardVideoMap.get(Number(board.id));
        async function normalizeBoardVideo(item: any) {
          const linkedVideo = item?.videoId ? videoMap.get(Number(item.videoId)) : null;
          if (!item) return null;
          if (!item.videoId) {
            return {
              id: item.id,
              videoId: item.videoId,
              model: item.model,
              prompt: item.prompt,
              promptLength: String(item.prompt || "").length,
              promptBytes: Buffer.byteLength(String(item.prompt || ""), "utf8"),
              duration: item.duration,
              resolution: item.resolution,
              state: item.state || "未生成",
              errorReason: item.errorReason || "",
              src: "",
            };
          }
          const normalizedState = normalizeVideoState(linkedVideo?.state || item.state);
          const errorReason = linkedVideo?.errorReason || item.errorReason || "";
          if (normalizedState !== item.state || errorReason !== (item.errorReason || "")) {
            await u.db("o_storyboardBoardVideo").where("id", item.id).update({
              state: normalizedState,
              errorReason,
              updateTime: Date.now(),
            });
          }
          return {
            id: item.id,
            videoId: item.videoId,
            model: item.model,
            prompt: item.prompt,
            promptLength: String(item.prompt || "").length,
            promptBytes: Buffer.byteLength(String(item.prompt || ""), "utf8"),
            duration: item.duration,
            resolution: item.resolution,
            state: normalizedState,
            errorReason,
            src: linkedVideo ? await getRenderableVideoSrc(linkedVideo) : "",
          };
        }
        const video = await normalizeBoardVideo(boardVideo);
        const videoHistory = (
          await Promise.all((boardVideoMap.get(Number(board.id)) || []).filter((item) => Number(item.videoId) > 0).map(normalizeBoardVideo))
        ).filter(Boolean);
        return {
          ...board,
          storyboardIds: parseStoryboardIds(board.storyboardIds),
          ...(await buildImageUrls(board)),
          ...(await buildVideoReferenceDebug(board)),
          video,
          videos: videoHistory,
        };
      }),
    );

    return res.status(200).send(success(result));
  },
);
