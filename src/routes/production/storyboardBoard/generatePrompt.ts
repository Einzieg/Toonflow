import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { prepareStoryboardBoardVideoPrompt } from "./generateVideo";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
    model: z.string(),
    duration: z.number(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { boardId, model, duration, resolution, audio = false } = req.body as {
      boardId: number;
      model: string;
      duration: number;
      resolution: string;
      audio?: boolean;
    };

    const running = await u.db("o_storyboardBoardVideo").where({ boardId, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) return res.status(200).send(success({ id: running.id, prompt: running.prompt, reused: true }));

    try {
      const prepared = await prepareStoryboardBoardVideoPrompt({ boardId, model, duration, resolution, audio });
      const now = Date.now();
      const draft = await u
        .db("o_storyboardBoardVideo")
        .where({ boardId, state: "未生成" })
        .whereNull("videoId")
        .orderBy("createTime", "desc")
        .first();
      const row = {
        boardId,
        projectId: prepared.projectId,
        scriptId: prepared.scriptId,
        videoId: null,
        referenceMode: prepared.videoReference.mode,
        model,
        prompt: prepared.prompt,
        duration: prepared.effectiveDuration,
        resolution,
        state: "未生成",
        errorReason: "",
        updateTime: now,
      };

      if (draft) {
        await u.db("o_storyboardBoardVideo").where("id", draft.id).update(row);
        return res.status(200).send(success({ id: draft.id, prompt: prepared.prompt }));
      }

      const [id] = await u.db("o_storyboardBoardVideo").insert({ ...row, createTime: now });
      return res.status(200).send(success({ id, prompt: prepared.prompt }));
    } catch (e) {
      const statusCode = Number((e as any)?.statusCode) || 400;
      return res.status(statusCode).send(error(u.error(e).message));
    }
  },
);
