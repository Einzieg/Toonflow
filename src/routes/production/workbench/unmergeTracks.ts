import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createManualStoryboardTrackKey, normalizeStoryboardDuration } from "@/utils/storyboardTrack";

const router = express.Router();

type SnapshotStoryboard = {
  id: number;
  track?: string | null;
};

type RestoreGroup = {
  sourceTrackId?: number | null;
  storyboards: SnapshotStoryboard[];
  videoIds: number[];
  trackData: Record<string, any>;
};

type UnmergeResult =
  | {
      ok: true;
      trackIds: number[];
      storyboardCount: number;
      videoCount: number;
      usedSnapshot: boolean;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

function normalizeStoryboards(value: unknown): SnapshotStoryboard[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<SnapshotStoryboard[]>((result, item: any) => {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0) return result;
    result.push({
      id,
      track: item?.track == null ? null : String(item.track),
    });
    return result;
  }, []);
}

function sameIdSet(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function createFallbackGroups(storyboardRows: any[]): RestoreGroup[] {
  return storyboardRows.map((row: any) => ({
    sourceTrackId: null,
    storyboards: [{ id: Number(row.id), track: String(Number(row.index) + 1) }],
    videoIds: [],
    trackData: {},
  }));
}

function buildSnapshotGroups(snapshotRows: any[], currentStoryboardIds: number[]): RestoreGroup[] | null {
  const groups = snapshotRows
    .map((row: any): RestoreGroup | null => {
      const storyboards = normalizeStoryboards(parseJson(row.storyboards, []));
      if (!storyboards.length) return null;
      return {
        sourceTrackId: Number(row.sourceTrackId) || null,
        storyboards,
        videoIds: normalizeIdList(parseJson(row.videoIds, [])),
        trackData: parseJson(row.trackData, {}),
      };
    })
    .filter((group): group is RestoreGroup => group != null);

  const snapshotStoryboardIds = groups.flatMap((group) => group.storyboards.map((item) => item.id));
  if (!groups.length || !sameIdSet(snapshotStoryboardIds, currentStoryboardIds)) return null;
  return groups;
}

function resolveStoryboardTrackValue(group: RestoreGroup, storyboard: SnapshotStoryboard, trackId: number, fallbackIndex: number) {
  const rawTrack = String(storyboard.track ?? "").trim();
  if (group.storyboards.length > 1) {
    return rawTrack.startsWith("manual:") ? createManualStoryboardTrackKey(trackId) : rawTrack || createManualStoryboardTrackKey(trackId);
  }
  if (!rawTrack || rawTrack.startsWith("manual:") || rawTrack === "__AUTO__") return String(fallbackIndex + 1);
  return rawTrack;
}

function selectExistingVideoId(candidates: unknown[], availableVideoIds: Set<number>) {
  for (const candidate of candidates) {
    const id = Number(candidate);
    if (Number.isInteger(id) && availableVideoIds.has(id)) return id;
  }
  return null;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackId } = req.body as {
      projectId: number;
      scriptId: number;
      trackId: number;
    };

    const result: UnmergeResult = await u.db.transaction(async (trx: any) => {
      const track = await trx("o_videoTrack").where({ projectId, scriptId, id: trackId }).first();
      if (!track) {
        return { ok: false, status: 404, message: "视频轨道不存在" } as const;
      }

      const storyboardRows = await trx("o_storyboard")
        .where({ projectId, scriptId, trackId })
        .orderBy("index", "asc")
        .select("id", "index", "duration", "track");
      if (storyboardRows.length < 2) {
        return { ok: false, status: 400, message: "当前轨道不是合并分镜" } as const;
      }

      const currentStoryboardIds = storyboardRows.map((row: any) => Number(row.id));
      const snapshotRows = await trx("o_videoTrackMergeSnapshot").where({ projectId, scriptId, targetTrackId: trackId }).orderBy("id", "asc");
      const snapshotGroups = buildSnapshotGroups(snapshotRows, currentStoryboardIds);
      const restoreGroups = snapshotGroups ?? createFallbackGroups(storyboardRows);
      const storyboardById = new Map<number, any>(storyboardRows.map((row: any) => [Number(row.id), row]));
      const currentVideos = await trx("o_video").where({ projectId, scriptId, videoTrackId: trackId }).orderBy("time", "asc").orderBy("id", "asc").select("id");
      const currentVideoIds = currentVideos.map((video: any) => Number(video.id)).filter((id: number) => Number.isInteger(id));
      const currentVideoIdSet = new Set(currentVideoIds);
      const snapshotVideoIdSet = new Set(restoreGroups.flatMap((group) => group.videoIds));
      const extraVideoIds = currentVideoIds.filter((id: number) => !snapshotVideoIdSet.has(id));

      const targetGroupIndex = Math.max(
        0,
        restoreGroups.findIndex((group) => Number(group.sourceTrackId) === trackId),
      );
      const groupTrackIds: number[] = [];

      for (let index = 0; index < restoreGroups.length; index += 1) {
        const group = restoreGroups[index];
        const groupDuration = Number(
          group.storyboards
            .reduce((sum, item) => {
              const storyboard = storyboardById.get(item.id);
              return sum + normalizeStoryboardDuration(storyboard?.duration);
            }, 0)
            .toFixed(3),
        );

        if (index === targetGroupIndex) {
          groupTrackIds[index] = trackId;
          await trx("o_videoTrack").where({ projectId, scriptId, id: trackId }).update({
            duration: group.trackData?.duration ?? groupDuration,
            prompt: group.trackData?.prompt ?? "",
            state: group.trackData?.state ?? null,
            reason: group.trackData?.reason ?? null,
            referenceMediaOverride: group.trackData?.referenceMediaOverride ?? null,
          });
          continue;
        }

        const [newTrackId] = await trx("o_videoTrack").insert({
          projectId,
          scriptId,
          duration: group.trackData?.duration ?? groupDuration,
          prompt: group.trackData?.prompt ?? "",
          state: group.trackData?.state ?? null,
          reason: group.trackData?.reason ?? null,
          referenceMediaOverride: group.trackData?.referenceMediaOverride ?? null,
        });
        groupTrackIds[index] = Number(newTrackId);
      }

      for (let index = 0; index < restoreGroups.length; index += 1) {
        const group = restoreGroups[index];
        const nextTrackId = groupTrackIds[index];
        for (const storyboard of group.storyboards) {
          const row = storyboardById.get(storyboard.id);
          if (!row) continue;
          await trx("o_storyboard")
            .where({ projectId, scriptId, id: storyboard.id })
            .update({
              trackId: nextTrackId,
              track: resolveStoryboardTrackValue(group, storyboard, nextTrackId, Number(row.index) || index),
            });
        }
      }

      for (let index = 0; index < restoreGroups.length; index += 1) {
        const group = restoreGroups[index];
        const nextTrackId = groupTrackIds[index];
        const groupVideoIds = group.videoIds.filter((id) => currentVideoIdSet.has(id));
        if (index === targetGroupIndex) groupVideoIds.push(...extraVideoIds);
        const uniqueGroupVideoIds = [...new Set(groupVideoIds)];
        if (uniqueGroupVideoIds.length) {
          await trx("o_video").where({ projectId, scriptId }).whereIn("id", uniqueGroupVideoIds).update({
            videoTrackId: nextTrackId,
          });
        }
        const groupVideoIdSet = new Set(uniqueGroupVideoIds);
        const selectedVideoId = selectExistingVideoId(
          [group.trackData?.videoId, group.trackData?.selectVideoId, uniqueGroupVideoIds[0]],
          groupVideoIdSet,
        );
        await trx("o_videoTrack").where({ projectId, scriptId, id: nextTrackId }).update({
          videoId: selectedVideoId,
          selectVideoId: selectedVideoId,
        });
      }

      await trx("o_videoTrackMergeSnapshot").where({ projectId, scriptId, targetTrackId: trackId }).del();

      return {
        ok: true,
        trackIds: groupTrackIds,
        storyboardCount: storyboardRows.length,
        videoCount: currentVideoIds.length,
        usedSnapshot: Boolean(snapshotGroups),
      } as const;
    });

    if (!result.ok) {
      return res.status(result.status).send(error(result.message));
    }
    res.status(200).send(success(result));
  },
);
