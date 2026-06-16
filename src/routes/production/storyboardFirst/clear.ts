import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { clearStoryboardFirstWorkflow } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    confirm: z.literal(true),
  }),
  async (req, res) => {
    const { projectId, scriptId, confirm } = req.body as { projectId: number; scriptId: number; confirm: true };
    try {
      await clearStoryboardFirstWorkflow(projectId, scriptId, confirm);
      return res.status(200).send(success(true));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
