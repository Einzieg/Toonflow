import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
    prompt: z.string(),
  }),
  async (req, res) => {
    const { boardId, prompt } = req.body as { boardId: number; prompt: string };
    const boardVideo = await u.db("o_storyboardBoardVideo").where({ boardId }).orderBy("createTime", "desc").first();
    if (!boardVideo) {
      const board = await u.db("o_storyboardBoard").where("id", boardId).first();
      if (!board) return res.status(404).send(error("故事板不存在"));
      const now = Date.now();
      const [id] = await u.db("o_storyboardBoardVideo").insert({
        boardId,
        projectId: board.projectId,
        scriptId: board.scriptId,
        videoId: null,
        prompt,
        state: "未生成",
        errorReason: "",
        createTime: now,
        updateTime: now,
      });
      return res.status(200).send(success({ id }));
    }

    if (boardVideo.state === "生成中") return res.status(400).send(error("故事板视频正在生成中，暂不能修改提示词"));
    await u.db("o_storyboardBoardVideo").where("id", boardVideo.id).update({
      prompt,
      updateTime: Date.now(),
    });

    return res.status(200).send(success({ id: boardVideo.id }));
  },
);
