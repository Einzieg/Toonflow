import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState, updateStoryboardFirstScript } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    firstScriptId: z.number(),
    shotScript: z.string(),
  }),
  async (req, res) => {
    const { firstScriptId, shotScript } = req.body as { firstScriptId: number; shotScript: string };
    try {
      await updateStoryboardFirstScript(firstScriptId, shotScript);
      const row = await u.db("o_storyboardFirstScript").where("id", firstScriptId).first();
      if (!row) return res.status(404).send(error("故事板先行分镜脚本不存在"));
      return res.status(200).send(success(await getStoryboardFirstState(Number(row.projectId), Number(row.scriptId))));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
