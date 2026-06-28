import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cleanupProductionEpisode } from "@/utils/productionCleanup";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
    clearAgentMemory: z.boolean().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, episodesId, clearAgentMemory } = req.body as {
        projectId: number;
        episodesId: number;
        clearAgentMemory?: boolean;
      };
      const result = await cleanupProductionEpisode({
        projectId,
        scriptId: episodesId,
        clearAgentMemory: clearAgentMemory !== false,
      });
      return res.status(200).send(success(result));
    } catch (e: any) {
      console.error("[production.clearEpisodeContent] failed", e);
      return res.status(500).send(error(e?.message || "清空当前分集生产内容失败"));
    }
  },
);
