import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { deleteStoryboardFirst } from "@/utils/storyboardFirst";
import u from "@/utils";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    firstScriptId: z.number().optional(),
    firstImageId: z.number().optional(),
  }),
  async (req, res) => {
    const { firstScriptId, firstImageId } = req.body as { firstScriptId?: number; firstImageId?: number };
    try {
      await deleteStoryboardFirst({ firstScriptId, firstImageId });
      return res.status(200).send(success(true));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }
  },
);
