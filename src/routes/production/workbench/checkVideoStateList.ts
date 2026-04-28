import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getRenderableVideoSrc, normalizeVideoState } from "@/utils/videoSource";

const router = express.Router();

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
    const trackIds = [...new Set(storyboardList.map((s) => s.trackId).filter((trackId): trackId is number => trackId != null))];

    if (!trackIds.length) {
      return res.status(200).send(success([]));
    }

    const query = u.db("o_video").whereIn("videoTrackId", trackIds);
    if (Array.isArray(videoIds) && videoIds.length > 0) {
      query.whereIn("id", videoIds);
    }

    const videoList = await query;
    const result = await Promise.all(
      videoList.map(async (item) => ({
        id: item.id!,
        videoTrackId: item.videoTrackId ?? null,
        state: normalizeVideoState(item.state),
        src: await getRenderableVideoSrc(item),
        errorReason: item.errorReason ?? "",
      })),
    );

    res.status(200).send(success(result));
  },
);
