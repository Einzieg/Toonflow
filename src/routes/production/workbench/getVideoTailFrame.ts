import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ensureTrackSelectedVideoTailFrame, ensureVideoTailFrameById } from "@/utils/videoTailFrame";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    videoId: z.number().optional(),
    trackId: z.number().optional(),
  }),
  async (req, res) => {
    const videoId = Number(req.body.videoId);
    const trackId = Number(req.body.trackId);
    try {
      if (Number.isInteger(videoId) && videoId > 0) {
        return res.status(200).send(success(await ensureVideoTailFrameById(videoId, req)));
      }
      if (Number.isInteger(trackId) && trackId > 0) {
        return res.status(200).send(success(await ensureTrackSelectedVideoTailFrame(trackId, req)));
      }
      return res.status(400).send(error("videoId 或 trackId 至少需要一个"));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
