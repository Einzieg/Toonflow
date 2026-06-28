import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增资产
export default router.post(
  "/",
  validateFields({
    name: z.string(),
    describe: z.string(),
    type: z.string(),
    projectId: z.number(),
    remark: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
    volcengineAssetUri: z.string().optional().nullable(),
    voiceProfile: z.string().optional().nullable(),
    voiceTone: z.string().optional().nullable(),
    speechRate: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { name, describe, type, projectId, remark, prompt, volcengineAssetUri, voiceProfile, voiceTone, speechRate } = req.body;
    await u.db("o_assets").insert({
      name,
      describe,
      type,
      projectId,
      remark,
      prompt,
      volcengineAssetUri: volcengineAssetUri?.trim() || null,
      voiceProfile: type === "role" ? voiceProfile?.trim() || null : null,
      voiceTone: type === "role" ? voiceTone?.trim() || null : null,
      speechRate: type === "role" ? speechRate?.trim() || null : null,
      startTime: Date.now(),
    });
    res.status(200).send(success({ message: "新增资产成功" }));
  },
);
