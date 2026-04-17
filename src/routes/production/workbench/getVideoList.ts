import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

function normalizeVideoState(state?: string | null) {
  if (state === "已完成" || state === "生成成功") return "已完成";
  if (state === "生成中") return "生成中";
  if (state === "生成失败") return "生成失败";
  return "未生成";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    videoIds: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, videoIds } = req.body as {
      projectId: number;
      scriptId: number;
      videoIds?: number[];
    };
    const storyboardList = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    const trackIds = storyboardList.map((s) => s.trackId).filter((trackId): trackId is number => trackId != null);
    const query = u.db("o_video").whereIn("videoTrackId", trackIds);
    if (Array.isArray(videoIds) && videoIds.length > 0) {
      query.whereIn("id", videoIds);
    }
    const videoList = trackIds.length ? await query : [];
    res.status(200).send(
      success(
        await Promise.all(
          videoList.map(async (s) => ({
            ...s,
            state: normalizeVideoState(s.state),
            src: s.filePath ? await u.oss.getFileUrl(s.filePath) : "",
          })),
        ),
      ),
    );
  },
);
