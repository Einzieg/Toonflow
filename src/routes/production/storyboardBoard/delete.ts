import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cleanupStoryboardVideoReferenceFiles } from "@/utils/storyboardVideoReference";

const router = express.Router();

async function deleteOssFileIfExists(filePath?: string | null) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    if (await u.oss.fileExists(normalized)) await u.oss.deleteFile(normalized);
  } catch (e) {
    console.warn("[storyboardBoard.delete] 清理文件失败:", normalized, u.error(e).message);
  }
}

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
  }),
  async (req, res) => {
    const { boardId } = req.body as { boardId: number };
    const board = await u.db("o_storyboardBoard").where("id", boardId).first();
    if (!board) return res.status(404).send(error("故事板不存在"));

    const boardVideos = await u.db("o_storyboardBoardVideo").where("boardId", boardId);
    const videoIds = boardVideos.map((item: any) => Number(item.videoId)).filter((id) => Number.isInteger(id));
    const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
    const deletableVideos = videos.filter((item: any) => item.videoTrackId == null);

    await deleteOssFileIfExists(board.filePath);
    await deleteOssFileIfExists(board.thumbPath);
    await cleanupStoryboardVideoReferenceFiles({
      videoReferencePath: board.videoReferencePath,
      frameManifest: board.frameManifest,
    });
    await Promise.all(deletableVideos.map((item: any) => deleteOssFileIfExists(item.filePath)));

    await u.db("o_storyboardBoardVideo").where("boardId", boardId).delete();
    if (deletableVideos.length) {
      await u
        .db("o_video")
        .whereIn(
          "id",
          deletableVideos.map((item: any) => item.id),
        )
        .delete();
    }
    await u.db("o_storyboardBoard").where("id", boardId).delete();

    return res.status(200).send(success(true));
  },
);
