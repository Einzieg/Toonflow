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

async function buildImageUrls(row: any) {
  const imageUrl = row.filePath ? await u.oss.getFileUrl(row.filePath) : "";
  const thumbUrl = row.thumbPath ? await u.oss.getFileUrl(row.thumbPath) : imageUrl ? u.oss.buildImagePreviewUrl(imageUrl, { width: 640, format: "webp" }) : "";
  return { imageUrl, thumbUrl };
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
    for (const item of boardVideos) {
      const boardId = Number(item.boardId);
      if (!latestBoardVideoMap.has(boardId)) latestBoardVideoMap.set(boardId, item);
    }

    const videoIds = Array.from(latestBoardVideoMap.values())
      .map((item: any) => Number(item.videoId))
      .filter((id) => Number.isInteger(id));
    const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
    const videoMap = new Map(videos.map((item: any) => [Number(item.id), item]));

    const result = await Promise.all(
      boards.map(async (board: any) => {
        const boardVideo = latestBoardVideoMap.get(Number(board.id));
        const linkedVideo = boardVideo ? videoMap.get(Number(boardVideo.videoId)) : null;
        let video = null;
        if (boardVideo) {
          const normalizedState = normalizeVideoState(linkedVideo?.state || boardVideo.state);
          const errorReason = linkedVideo?.errorReason || boardVideo.errorReason || "";
          if (normalizedState !== boardVideo.state || errorReason !== (boardVideo.errorReason || "")) {
            await u.db("o_storyboardBoardVideo").where("id", boardVideo.id).update({
              state: normalizedState,
              errorReason,
              updateTime: Date.now(),
            });
          }
          video = {
            id: boardVideo.id,
            videoId: boardVideo.videoId,
            model: boardVideo.model,
            prompt: boardVideo.prompt,
            duration: boardVideo.duration,
            resolution: boardVideo.resolution,
            state: normalizedState,
            errorReason,
            src: linkedVideo ? await getRenderableVideoSrc(linkedVideo) : "",
          };
        }
        return {
          ...board,
          storyboardIds: parseStoryboardIds(board.storyboardIds),
          ...(await buildImageUrls(board)),
          video,
        };
      }),
    );

    return res.status(200).send(success(result));
  },
);
