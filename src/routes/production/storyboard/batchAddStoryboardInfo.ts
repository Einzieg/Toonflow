import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { expandStoryboardItemsForDuration, planStoryboardTrackSegments } from "@/utils/storyboardTrack";
const router = express.Router();

interface InputStoryboardItem {
  prompt: string;
  duration: number;
  track: string;
  state: string;
  src: string | null;
  videoDesc: string;
  shouldGenerateImage: number;
  associateAssetsIds: number[];
}

interface ExistingStoryboardItem {
  id?: number;
  track?: string | null;
  trackId?: number | null;
  prompt?: string | null;
  duration?: string | null;
  videoDesc?: string | null;
  index?: number | null;
}

async function syncStoryboardTracks(projectId: number, scriptId: number) {
  const storyboardRows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderBy("index", "asc")
    .select("id", "index", "track", "trackId", "duration");

  const plannedSegments = planStoryboardTrackSegments(storyboardRows);
  const reusedTrackIds = new Set<number>();

  for (const segment of plannedSegments) {
    const storyboardIds = segment.items.map((item) => item.id).filter((id): id is number => id != null);
    if (!storyboardIds.length) continue;

    const candidateTrackId =
      segment.items
        .map((item) => item.trackId)
        .find((trackId): trackId is number => trackId != null && !reusedTrackIds.has(trackId)) ?? null;

    let trackId = candidateTrackId;
    if (trackId == null) {
      const [newTrackId] = await u.db("o_videoTrack").insert({
        scriptId,
        projectId,
        duration: segment.duration,
      });
      trackId = newTrackId;
    } else {
      const membershipChanged = segment.items.some((item) => item.trackId !== trackId || String(item.track ?? "") !== segment.trackLabel);
      await u
        .db("o_videoTrack")
        .where("id", trackId)
        .update({
          duration: segment.duration,
          ...(membershipChanged
            ? {
                prompt: "",
                reason: null,
                state: null,
                videoId: null,
                selectVideoId: null,
              }
            : {}),
        });
    }

    reusedTrackIds.add(trackId);
    await u.db("o_storyboard").whereIn("id", storyboardIds).update({
      trackId,
      track: segment.trackLabel,
    });
  }
}

export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        prompt: z.string(),
        duration: z.number(),
        track: z.string(),
        state: z.string(),
        src: z.string().nullable(),
        videoDesc: z.string(),
        shouldGenerateImage: z.number(),
        associateAssetsIds: z.array(z.number()),
      }),
    ),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { data: rawData, scriptId, projectId }: { data: InputStoryboardItem[]; scriptId: number; projectId: number } = req.body;
    if (!rawData.length) return res.status(400).send({ success: false, message: "数据不能为空" });
    const data = expandStoryboardItemsForDuration<InputStoryboardItem>(rawData);
    const replaceAll = rawData.length > 1;
    const existingStoryboards: ExistingStoryboardItem[] = await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .select("id", "track", "trackId", "prompt", "duration", "videoDesc", "index");

    const existingStoryboardIds = existingStoryboards.map((item: any) => item.id).filter(Boolean);
    if (replaceAll && existingStoryboardIds.length) {
      await u.db("o_assets2Storyboard").whereIn("storyboardId", existingStoryboardIds).del();
      await u.db("o_storyboard").whereIn("id", existingStoryboardIds).del();
    }

    const insertedStoryboards: Array<(typeof data)[number] & { id: number; index: number }> = [];
    const nextIndexBase = replaceAll
      ? 0
      : existingStoryboards.reduce((max: number, item) => Math.max(max, Number(item.index ?? -1)), -1) + 1;
    for (const [index, item] of data.entries()) {
      const targetIndex = replaceAll ? index : nextIndexBase + index;
      const matchedStoryboard = replaceAll
        ? null
        : existingStoryboards.find(
            (storyboard) =>
            storyboard.prompt === item.prompt &&
            String(storyboard.duration ?? "") === String(item.duration) &&
            (storyboard.videoDesc ?? "") === item.videoDesc &&
            (storyboard.track ?? "") === item.track,
          ) ?? null;

      let id: number;
      if (matchedStoryboard?.id) {
        id = matchedStoryboard.id;
        await u.db("o_storyboard").where("id", id).update({
          prompt: item.prompt,
          duration: String(item.duration),
          state: item.state,
          track: item.track,
          videoDesc: item.videoDesc,
          shouldGenerateImage: item.shouldGenerateImage,
          index: matchedStoryboard.index ?? targetIndex,
        });
        await u.db("o_assets2Storyboard").where("storyboardId", id).del();
      } else {
        const inserted = await u.db("o_storyboard").insert({
          prompt: item.prompt,
          duration: String(item.duration),
          state: item.state,
          scriptId,
          projectId,
          index: targetIndex,
          track: item.track,
          videoDesc: item.videoDesc,
          shouldGenerateImage: item.shouldGenerateImage,
          createTime: Date.now(),
        });
        id = Number(inserted[0]);
      }
      if (item.associateAssetsIds?.length) {
        await u.db("o_assets2Storyboard").insert(
          item.associateAssetsIds.map((assetId: number) => ({
            assetId,
            storyboardId: id,
          })),
        );
      }
      insertedStoryboards.push({ ...item, id, index: matchedStoryboard?.index ?? targetIndex });
    }
    if (!insertedStoryboards.length) return res.status(400).send(error("未查到分镜数据"));
    await syncStoryboardTracks(projectId, scriptId);

    const insertedTrackRows = await u.db("o_storyboard").whereIn(
      "id",
      insertedStoryboards.map((item) => item.id),
    );
    const trackIdMapByStoryboardId = new Map<number, number>();
    const trackLabelMapByStoryboardId = new Map<number, string>();
    insertedTrackRows.forEach((item: any) => {
      if (item.id && item.trackId) {
        trackIdMapByStoryboardId.set(item.id, item.trackId);
      }
      if (item.id && item.track != null) {
        trackLabelMapByStoryboardId.set(item.id, String(item.track));
      }
    });

    const storyboardData = await Promise.all(
      insertedStoryboards.map(async (i) => {
        return {
          associateAssetsIds: await u.db("o_assets2Storyboard").where("storyboardId", i.id).select("assetId").pluck("assetId"),
          src: i.src ?? "",
          id: i.id,
          index: i.index,
          track: trackLabelMapByStoryboardId.get(i.id) ?? i.track,
          trackId: trackIdMapByStoryboardId.get(i.id),
          prompt: i.prompt,
          duration: Number(i.duration),
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
          scriptId,
          reason: "",
        };
      }),
    );
    return res.status(200).send(success(storyboardData));
  },
);
