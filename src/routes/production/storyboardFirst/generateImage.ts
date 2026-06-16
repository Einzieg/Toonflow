import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState, startGenerateStoryboardFirstImage } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    firstScriptId: z.number(),
    force: z.boolean().optional(),
  }),
  async (req, res) => {
    const { firstScriptId, force = false } = req.body as { firstScriptId: number; force?: boolean };
    try {
      const result = await startGenerateStoryboardFirstImage(firstScriptId, force);
      const row = await u.db("o_storyboardFirstScript").where("id", firstScriptId).first();
      if (!row) return res.status(404).send(error("故事板先行分镜脚本不存在"));
      return res.status(200).send(success({ ...result, workflow: await getStoryboardFirstState(Number(row.projectId), Number(row.scriptId)) }));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
