import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureVideoTailFrame } from "@/utils/videoTailFrame";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    videoId: z.number(),
  }),
  async (req, res) => {
    const { trackId, videoId } = req.body;
    await u.db("o_videoTrack").where("id", trackId).update({
      videoId: videoId,
    });
    const video = await u.db("o_video").where("id", videoId).first();
    if (video) {
      try {
        await ensureVideoTailFrame(video, req);
      } catch (e) {
        console.warn("[selectVideo] tail frame cache failed:", {
          videoId,
          message: u.error(e).message,
        });
      }
    }
    res.status(200).send(success({ message: "视频选择成功" }));
  },
);
