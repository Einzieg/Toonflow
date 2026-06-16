import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getStoryboardFirstState } from "@/utils/storyboardFirst";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body as { projectId: number; scriptId: number };
    const data = await getStoryboardFirstState(projectId, scriptId);
    return res.status(200).send(success(data));
  },
);
