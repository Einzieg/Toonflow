import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getVideoTailFramePath } from "@/utils/videoTailFrame";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const video = await u.db("o_video").where("id", id).select("id", "projectId").first();
    if (video?.projectId && (await u.oss.fileExists(getVideoTailFramePath(Number(id), Number(video.projectId))))) {
      await u.oss.deleteFile(getVideoTailFramePath(Number(id), Number(video.projectId)));
    }
    await u.db("o_video").where("id", id).delete();
    await u.db("o_videoTrack").where("videoId", id).update({
      videoId: null,
    });
    res.status(200).send(success({ message: "视频删除成功" }));
  },
);
