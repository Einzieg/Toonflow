import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState, startGenerateStoryboardFirstScript } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    targetDuration: z.number().optional(),
    force: z.boolean().optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, targetDuration, force = false } = req.body as {
      projectId: number;
      scriptId: number;
      targetDuration?: number;
      force?: boolean;
    };
    try {
      const result = await startGenerateStoryboardFirstScript({ projectId, scriptId, targetDuration, force });
      return res.status(200).send(success({ ...result, workflow: await getStoryboardFirstState(projectId, scriptId) }));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
