import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createManualStoryboardTrackKey, resolveStoryboardTrackTargetDuration } from "@/utils/storyboardTrack";

const router = express.Router();

type MergeResult =
  | {
      ok: true;
      targetTrackId: number;
      mergedTrackIds: number[];
      storyboardCount: number;
      videoCount: number;
      duration: number;
    }
  | {
      ok: false;
      status: number;
      message: string;
    };

function normalizeTrackIds(trackIds: number[]) {
  return [...new Set(trackIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function mergeError(status: number, message: string): MergeResult {
  return { ok: false, status, message };
}

function mergeSuccess(input: Omit<Extract<MergeResult, { ok: true }>, "ok">): MergeResult {
  return { ok: true, ...input };
}

async function getProjectVideoModelDetail(projectData: any) {
  const [vendorId, modelName] = String(projectData?.videoModel || "").split(/:(.+)/);
  if (!vendorId || !modelName) return null;
  try {
    const models = await u.vendor.getModelList(vendorId);
    return models.find((item: any) => item.modelName === modelName) ?? null;
  } catch {
    return null;
  }
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackIds: z.array(z.number()).min(2),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackIds } = req.body as {
      projectId: number;
      scriptId: number;
      trackIds: number[];
    };
    const normalizedTrackIds = normalizeTrackIds(trackIds);
    if (normalizedTrackIds.length < 2) {
      return res.status(400).send(error("至少选择两个分镜轨道"));
    }

    const projectData = await u.db("o_project").where("id", projectId).select("videoModel").first();
    const modelDetail = await getProjectVideoModelDetail(projectData);
    const trackTargetDuration = resolveStoryboardTrackTargetDuration(
      projectData?.videoModel,
      modelDetail?.name || modelDetail?.modelName,
      modelDetail?.durationResolutionMap,
    );

    const result: MergeResult = await u.db.transaction(async (trx: any) => {
      const selectedTrackRows = await trx("o_videoTrack").where({ projectId, scriptId }).whereIn("id", normalizedTrackIds);
      if (selectedTrackRows.length !== normalizedTrackIds.length) {
        return mergeError(404, "部分视频轨道不存在");
      }

      const storyboardRows = await trx("o_storyboard").where({ projectId, scriptId }).orderBy("index", "asc").select("id", "trackId", "duration");
      const orderedTrackIds: number[] = [];
      const seenTrackIds = new Set<number>();
      storyboardRows.forEach((row: any) => {
        const trackId = Number(row.trackId);
        if (!Number.isInteger(trackId) || seenTrackIds.has(trackId)) return;
        seenTrackIds.add(trackId);
        orderedTrackIds.push(trackId);
      });

      const selectedTrackIdSet = new Set(normalizedTrackIds);
      const orderedSelectedTrackIds = orderedTrackIds.filter((trackId) => selectedTrackIdSet.has(trackId));
      if (orderedSelectedTrackIds.length !== normalizedTrackIds.length) {
        return mergeError(400, "只能合并已关联分镜的轨道");
      }

      const selectedPositions = orderedSelectedTrackIds.map((trackId) => orderedTrackIds.indexOf(trackId));
      const minPosition = Math.min(...selectedPositions);
      const maxPosition = Math.max(...selectedPositions);
      if (maxPosition - minPosition + 1 !== normalizedTrackIds.length) {
        return mergeError(400, "只能合并相邻的分镜轨道");
      }

      const selectedStoryboardRows = storyboardRows.filter((row: any) => selectedTrackIdSet.has(Number(row.trackId)));
      if (!selectedStoryboardRows.length) {
        return mergeError(400, "所选轨道没有可合并的分镜");
      }

      const targetTrackId = orderedSelectedTrackIds[0];
      const removeTrackIds = orderedSelectedTrackIds.slice(1);
      const manualTrackKey = createManualStoryboardTrackKey(targetTrackId);
      const selectedVideos = await trx("o_video")
        .where({ projectId, scriptId })
        .whereIn("videoTrackId", orderedSelectedTrackIds)
        .orderBy("time", "asc")
        .orderBy("id", "asc")
        .select("id", "videoTrackId");
      const selectedVideoIdSet = new Set(selectedVideos.map((video: any) => Number(video.id)).filter((id: number) => Number.isInteger(id)));
      const selectedTrackRowsById = new Map<number, any>(selectedTrackRows.map((track: any) => [Number(track.id), track]));
      const preferredVideoId =
        orderedSelectedTrackIds
          .flatMap((trackId) => {
            const track = selectedTrackRowsById.get(trackId);
            return [Number(track?.videoId), Number(track?.selectVideoId)];
          })
          .find((videoId) => selectedVideoIdSet.has(videoId)) ??
        selectedVideos.find((video: any) => Number(video.videoTrackId) === targetTrackId)?.id ??
        selectedVideos[0]?.id ??
        null;
      const duration = Number(
        selectedStoryboardRows
          .reduce((sum: number, row: any) => {
            const value = Number(row.duration);
            return sum + (Number.isFinite(value) && value > 0 ? value : 0);
          }, 0)
          .toFixed(3),
      );
      if (duration > trackTargetDuration + 0.001) {
        return mergeError(400, `合并后时长 ${duration}s 超出当前模型上限 ${trackTargetDuration}s，请减少选择的分镜`);
      }

      await trx("o_videoTrackMergeSnapshot").where({ projectId, scriptId, targetTrackId }).del();
      const now = Date.now();
      const snapshots = orderedSelectedTrackIds.map((sourceTrackId) => {
        const track = selectedTrackRowsById.get(sourceTrackId);
        const sourceStoryboards = selectedStoryboardRows
          .filter((row: any) => Number(row.trackId) === sourceTrackId)
          .map((row: any) => ({
            id: Number(row.id),
            track: row.track ?? null,
          }));
        const sourceVideoIds = selectedVideos
          .filter((video: any) => Number(video.videoTrackId) === sourceTrackId)
          .map((video: any) => Number(video.id))
          .filter((id: number) => Number.isInteger(id));
        return {
          projectId,
          scriptId,
          targetTrackId,
          sourceTrackId,
          storyboards: JSON.stringify(sourceStoryboards),
          videoIds: JSON.stringify(sourceVideoIds),
          trackData: JSON.stringify({
            duration: track?.duration ?? null,
            prompt: track?.prompt ?? "",
            state: track?.state ?? null,
            reason: track?.reason ?? null,
            videoId: track?.videoId ?? null,
            selectVideoId: track?.selectVideoId ?? null,
            referenceMediaOverride: track?.referenceMediaOverride ?? null,
          }),
          createTime: now,
        };
      });
      if (snapshots.length) {
        await trx("o_videoTrackMergeSnapshot").insert(snapshots);
      }

      await trx("o_storyboard").where({ projectId, scriptId }).whereIn("trackId", orderedSelectedTrackIds).update({
        trackId: targetTrackId,
        track: manualTrackKey,
      });
      if (selectedVideos.length) {
        await trx("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", orderedSelectedTrackIds).update({
          videoTrackId: targetTrackId,
        });
      }
      await trx("o_videoTrack").where({ projectId, scriptId, id: targetTrackId }).update({
        duration,
        state: null,
        reason: null,
        prompt: "",
        videoId: preferredVideoId,
        selectVideoId: preferredVideoId,
        referenceMediaOverride: null,
      });
      if (removeTrackIds.length) {
        await trx("o_videoTrack").where({ projectId, scriptId }).whereIn("id", removeTrackIds).del();
      }

      return mergeSuccess({
        targetTrackId,
        mergedTrackIds: orderedSelectedTrackIds,
        storyboardCount: selectedStoryboardRows.length,
        videoCount: selectedVideos.length,
        duration,
      });
    });

    if (!result.ok) {
      return res.status(result.status).send(error(result.message));
    }
    res.status(200).send(success(result));
  },
);
