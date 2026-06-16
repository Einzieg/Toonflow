import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState, regenerateStoryboardFirstImage } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    firstImageId: z.number(),
  }),
  async (req, res) => {
    const { firstImageId } = req.body as { firstImageId: number };
    try {
      const image = await u.db("o_storyboardFirstImage").where("id", firstImageId).first();
      if (!image) return res.status(404).send(error("故事板先行图片不存在"));
      const result = await regenerateStoryboardFirstImage(firstImageId);
      return res.status(200).send(success({ ...result, workflow: await getStoryboardFirstState(Number(image.projectId), Number(image.scriptId)) }));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
