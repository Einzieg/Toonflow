import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  expandStoryboardItemsForDuration,
  getPlannedStoryboardTrackStorageValue,
  planStoryboardTrackSegments,
  resolveStoryboardTrackTargetDuration,
} from "@/utils/storyboardTrack";
import { normalizeStoryboardAssociateAssets, type StoryboardAssetProjectAsset } from "@/utils/storyboardAssetRefs";
import { generateStoryboardImagePromptWithAI } from "@/utils/storyboardImagePrompt";
import { resolveStoryboardPanelMode } from "@/utils/storyboardPanelMode";
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
  const [storyboardRows, projectData] = await Promise.all([
    u
      .db("o_storyboard")
      .where({ projectId, scriptId })
      .orderBy("index", "asc")
      .select("id", "index", "track", "trackId", "duration", "videoDesc"),
    u.db("o_project").where("id", projectId).select("videoModel").first(),
  ]);

  const modelDetail = await getProjectVideoModelDetail(projectData);
  const trackTargetDuration = resolveStoryboardTrackTargetDuration(projectData?.videoModel, modelDetail?.name || modelDetail?.modelName, modelDetail?.durationResolutionMap);
  const plannedSegments = planStoryboardTrackSegments(storyboardRows, trackTargetDuration);
  const reusedTrackIds = new Set<number>();
  const originalStoryboardIdsByTrackId = new Map<number, Set<number>>();
  storyboardRows.forEach((row: any) => {
    const trackId = Number(row.trackId);
    const storyboardId = Number(row.id);
    if (!Number.isInteger(trackId) || !Number.isInteger(storyboardId)) return;
    const storyboardIds = originalStoryboardIdsByTrackId.get(trackId) ?? new Set<number>();
    storyboardIds.add(storyboardId);
    originalStoryboardIdsByTrackId.set(trackId, storyboardIds);
  });

  for (const segment of plannedSegments) {
    const storyboardIds = segment.items.map((item) => item.id).filter((id): id is number => id != null);
    if (!storyboardIds.length) continue;
    const trackStorageValue = getPlannedStoryboardTrackStorageValue(segment);

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
      const originalStoryboardIds = originalStoryboardIdsByTrackId.get(trackId);
      const segmentStoryboardIdSet = new Set(storyboardIds.map(Number));
      const trackMembershipChanged =
        originalStoryboardIds != null &&
        (originalStoryboardIds.size !== segmentStoryboardIdSet.size || [...originalStoryboardIds].some((id) => !segmentStoryboardIdSet.has(id)));
      const membershipChanged = trackMembershipChanged || segment.items.some((item) => item.trackId !== trackId || String(item.track ?? "") !== trackStorageValue);
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
      track: trackStorageValue,
    });
  }

  const existingTrackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
  const staleTrackIds = existingTrackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id) && !reusedTrackIds.has(id));
  if (staleTrackIds.length) {
    const trackIdsWithVideos = new Set(
      (await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", staleTrackIds).select("videoTrackId")).map((item: any) =>
        Number(item.videoTrackId),
      ),
    );
    const emptyStaleTrackIds = staleTrackIds.filter((trackId) => !trackIdsWithVideos.has(trackId));
    if (emptyStaleTrackIds.length) {
      await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", emptyStaleTrackIds).del();
    }
  }

  // Track grouping must not change image generation intent. Grok single-image
  // video generation chooses one reference at request time instead of marking
  // the remaining storyboard frames as "do not generate" in the panel.
}

async function getProjectVideoModelDetail(projectData: any) {
  const [vendorId, modelName] = String(projectData?.videoModel || "").split(/:(.+)/);
  if (!vendorId || !modelName) return null;
  const models = await u.vendor.getModelList(vendorId);
  return models.find((item: any) => item.modelName === modelName) ?? null;
}

async function clearExistingStoryboardPanel(projectId: number, scriptId: number, existingStoryboards: ExistingStoryboardItem[]) {
  const storyboardIds = existingStoryboards.map((item) => Number(item.id)).filter((id) => Number.isInteger(id));
  const referencedTrackIds = existingStoryboards.map((item) => Number(item.trackId)).filter((id) => Number.isInteger(id));
  const allTrackIds = (await u.db("o_videoTrack").where({ projectId, scriptId }).select("id"))
    .map((item: any) => Number(item.id))
    .filter((id: number) => Number.isInteger(id));
  const trackIds = Array.from(new Set([...referencedTrackIds, ...allTrackIds]));
  if (storyboardIds.length) {
    await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).del();
    await u.db("o_storyboard").whereIn("id", storyboardIds).del();
  }
  if (trackIds.length) {
    await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds).del();
    await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).del();
  }
}

function normalizeTrackLabel(track: string | null | undefined) {
  return String(track ?? "").trim();
}

function shouldAutoReplaceRestartingPanel(rawData: InputStoryboardItem[], existingStoryboards: ExistingStoryboardItem[], replaceAll: boolean) {
  if (replaceAll || !existingStoryboards.length || !rawData.length) return false;
  const firstTrack = normalizeTrackLabel(rawData[0]?.track);
  if (firstTrack !== "1") return false;
  const hasExistingFirstTrack = existingStoryboards.some((item) => normalizeTrackLabel(item.track) === "1");
  const hasExistingLaterTrack = existingStoryboards.some((item) => {
    const value = Number(normalizeTrackLabel(item.track));
    return Number.isFinite(value) && value > 1;
  });
  return hasExistingFirstTrack && hasExistingLaterTrack;
}

function normalizePromptText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    replaceAll: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      data: rawData,
      scriptId,
      projectId,
      replaceAll = false,
    }: { data: InputStoryboardItem[]; scriptId: number; projectId: number; replaceAll?: boolean } = req.body;
    if (!rawData.length) return res.status(400).send({ success: false, message: "数据不能为空" });
    const projectData = await u.db("o_project").where("id", projectId).select("videoModel", "mode", "artStyle").first();
    const modelDetail = await getProjectVideoModelDetail(projectData);
    const panelMode = resolveStoryboardPanelMode(projectData, modelDetail);
    const panelShouldGenerateImage = panelMode.mode !== "text";
    const maxStoryboardDuration = resolveStoryboardTrackTargetDuration(projectData?.videoModel, modelDetail?.name || modelDetail?.modelName, modelDetail?.durationResolutionMap);
    const data = expandStoryboardItemsForDuration<InputStoryboardItem>(rawData, maxStoryboardDuration);
    const projectAssets: StoryboardAssetProjectAsset[] = await u.db("o_assets").where({ projectId }).select("id", "name", "type", "describe");
    const projectAssetById = new Map(projectAssets.map((asset) => [Number(asset.id), asset]));
    const existingStoryboards: ExistingStoryboardItem[] = await u
      .db("o_storyboard")
      .where({ scriptId, projectId })
      .select("id", "track", "trackId", "prompt", "duration", "videoDesc", "index");

    const effectiveReplaceAll = replaceAll || shouldAutoReplaceRestartingPanel(rawData, existingStoryboards, replaceAll);
    const activeExistingStoryboards = effectiveReplaceAll ? [] : existingStoryboards;
    const existingStoryboardIds = existingStoryboards.map((item: any) => item.id).filter(Boolean);
    console.log(
      `[storyboard.batchAdd] projectId=${projectId} scriptId=${scriptId} rawCount=${rawData.length} expandedCount=${data.length} replaceAll=${replaceAll} effectiveReplaceAll=${effectiveReplaceAll} panelMode=${panelMode.mode} reason=${panelMode.reason}`,
    );
    if (effectiveReplaceAll && existingStoryboardIds.length) {
      await clearExistingStoryboardPanel(projectId, scriptId, existingStoryboards);
    }

    const insertedStoryboards: Array<(typeof data)[number] & { id: number; index: number }> = [];
    const nextIndexBase = effectiveReplaceAll
      ? 0
      : activeExistingStoryboards.reduce((max: number, item) => Math.max(max, Number(item.index ?? -1)), -1) + 1;
    for (const [index, item] of data.entries()) {
      const targetIndex = effectiveReplaceAll ? index : nextIndexBase + index;
      const matchedStoryboard = effectiveReplaceAll
        ? null
        : activeExistingStoryboards.find(
            (storyboard) =>
              storyboard.prompt === item.prompt &&
              String(storyboard.duration ?? "") === String(item.duration) &&
              (storyboard.videoDesc ?? "") === item.videoDesc &&
              (storyboard.track ?? "") === item.track,
          ) ?? null;

      const initialAssetIds = normalizeStoryboardAssociateAssets(
        {
          associateAssetsIds: item.associateAssetsIds,
          prompt: item.prompt,
          videoDesc: item.videoDesc,
        },
        projectAssets,
      );
      let finalPrompt = normalizePromptText(item.prompt);
      const finalShouldGenerateImage = panelShouldGenerateImage ? 1 : 0;
      if (finalShouldGenerateImage && !finalPrompt) {
        const promptAssets = initialAssetIds.map((assetId) => projectAssetById.get(assetId)).filter((asset): asset is StoryboardAssetProjectAsset => Boolean(asset));
        finalPrompt = await generateStoryboardImagePromptWithAI({
          fields: {
            index: targetIndex,
            duration: item.duration,
            videoDesc: item.videoDesc,
          },
          assets: promptAssets,
          artStyle: projectData?.artStyle,
          projectId,
          fallbackOnError: true,
        });
      }

      let id: number;
      if (matchedStoryboard?.id) {
        id = matchedStoryboard.id;
        await u.db("o_storyboard").where("id", id).update({
          prompt: finalPrompt,
          duration: String(item.duration),
          state: item.state,
          track: item.track,
          videoDesc: item.videoDesc,
          shouldGenerateImage: finalShouldGenerateImage,
          index: matchedStoryboard.index ?? targetIndex,
        });
        await u.db("o_assets2Storyboard").where("storyboardId", id).del();
      } else {
        const inserted = await u.db("o_storyboard").insert({
          prompt: finalPrompt,
          duration: String(item.duration),
          state: item.state,
          scriptId,
          projectId,
          index: targetIndex,
          track: item.track,
          videoDesc: item.videoDesc,
          shouldGenerateImage: finalShouldGenerateImage,
          createTime: Date.now(),
        });
        id = Number(inserted[0]);
      }
      const normalizedAssociateAssetsIds = normalizeStoryboardAssociateAssets(
        {
          associateAssetsIds: initialAssetIds,
          prompt: finalPrompt,
          videoDesc: item.videoDesc,
        },
        projectAssets,
      );
      const uniqueAssetIds = Array.from(
        new Set(normalizedAssociateAssetsIds.filter((assetId): assetId is number => Number.isInteger(assetId))),
      );
      if (uniqueAssetIds.length) {
        await u.db("o_assets2Storyboard").insert(
          uniqueAssetIds.map((assetId: number) => ({
            assetId,
            storyboardId: id,
          })),
        );
      }
      insertedStoryboards.push({ ...item, prompt: finalPrompt, shouldGenerateImage: finalShouldGenerateImage, id, index: matchedStoryboard?.index ?? targetIndex });
    }
    if (!insertedStoryboards.length) return res.status(400).send(error("未查到分镜数据"));
    await syncStoryboardTracks(projectId, scriptId);

    const insertedTrackRows = await u.db("o_storyboard").whereIn(
      "id",
      insertedStoryboards.map((item) => item.id),
    );
    const trackIdMapByStoryboardId = new Map<number, number>();
    const trackLabelMapByStoryboardId = new Map<number, string>();
    const shouldGenerateImageMapByStoryboardId = new Map<number, number>();
    insertedTrackRows.forEach((item: any) => {
      if (item.id && item.trackId) {
        trackIdMapByStoryboardId.set(item.id, item.trackId);
      }
      if (item.id && item.track != null) {
        trackLabelMapByStoryboardId.set(item.id, String(item.track));
      }
      if (item.id) {
        shouldGenerateImageMapByStoryboardId.set(item.id, Number(item.shouldGenerateImage ?? 0));
      }
    });

    const storyboardData = await Promise.all(
      insertedStoryboards.map(async (i) => {
        return {
          associateAssetsIds: await u.db("o_assets2Storyboard").where("storyboardId", i.id).orderBy("rowid").pluck("assetId"),
          src: i.src ?? "",
          id: i.id,
          index: i.index,
          track: trackLabelMapByStoryboardId.get(i.id) ?? i.track,
          trackId: trackIdMapByStoryboardId.get(i.id),
          prompt: i.prompt,
          duration: Number(i.duration),
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: shouldGenerateImageMapByStoryboardId.get(i.id) ?? i.shouldGenerateImage,
          scriptId,
          reason: "",
        };
      }),
    );
    return res.status(200).send(success(storyboardData));
  },
);
