import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState, startGenerateStoryboardFirstVideo } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    firstImageId: z.number(),
    model: z.string(),
    duration: z.number(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { firstImageId, model, duration, resolution, audio = false } = req.body as {
      firstImageId: number;
      model: string;
      duration: number;
      resolution: string;
      audio?: boolean;
    };
    try {
      const image = await u.db("o_storyboardFirstImage").where("id", firstImageId).first();
      if (!image) return res.status(404).send(error("故事板先行图片不存在"));
      const result = await startGenerateStoryboardFirstVideo({ firstImageId, model, duration, resolution, audio, req });
      return res.status(200).send(success({ ...result, workflow: await getStoryboardFirstState(Number(image.projectId), Number(image.scriptId)) }));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
