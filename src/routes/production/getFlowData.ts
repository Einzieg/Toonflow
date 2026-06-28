import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();
import { FlowData } from "@/agents/productionAgent/tools";
import { syncProductionScriptToWorkData } from "@/utils/productionWorkDataSync";
import { ensureStoryboardTracks } from "@/utils/storyboardPanelSync";
import { normalizeStoryboardShotMeta } from "@/utils/storyboardShotMeta";

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  async (req, res) => {
    const { projectId, episodesId }: { projectId: number; episodesId: number } = req.body;
    const resolveAssetImage = async (filePath?: string | null) => {
      if (!filePath) {
        return {
          src: null,
          thumbSrc: null,
        };
      }

      const src = await u.oss.getFileUrl(filePath);
      return {
        src,
        thumbSrc: u.oss.buildImagePreviewUrl(src, { width: 480, format: "webp" }),
      };
    };
    const parseShotMeta = (value: unknown, input: { videoDesc?: string | null; duration?: number | string | null; sourceShotNo?: number | string | null } = {}) => {
      if (!value) return null;
      if (typeof value === "object") return normalizeStoryboardShotMeta(value as Record<string, any>, input);
      try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === "object" ? normalizeStoryboardShotMeta(parsed, input) : null;
      } catch {
        return null;
      }
    };

    const sqlData = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .where("key", "productionAgent")
      .andWhere("episodesId", String(episodesId))
      .select("id", "data")
      .first();

    const scriptData = await u.db("o_script").where("projectId", projectId).where("id", episodesId).first();
    const scriptAssets = await u.db("o_scriptAssets").where("scriptId", episodesId);
    const assetIds = scriptAssets.map((i) => i.assetId);
    const assetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
      // @ts-ignore
      .where("o_assets.id", "in", assetIds)
      .andWhere("o_assets.assetsId", null)
      .where("o_assets.projectId", projectId);

    const childAssetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
      .where("o_assets.projectId", projectId)
      // @ts-ignore
      .where("o_assets.assetsId", "in", assetIds)
      .whereNotNull("o_assets.assetsId");

    await ensureStoryboardTracks(projectId, episodesId);
    const storyboardData = await u.db("o_storyboard").where({ projectId, scriptId: episodesId });
    const resolvedStoryboardData = await Promise.all(
      storyboardData.map(async (item) => {
        if (!item.filePath) {
          return {
            ...item,
            filePath: "",
            thumbSrc: "",
          };
        }

        try {
          const fileUrl = await u.oss.getFileUrl(item.filePath);
          return {
            ...item,
            filePath: fileUrl,
            thumbSrc: u.oss.buildImagePreviewUrl(fileUrl, { width: 480, format: "webp" }),
          };
        } catch {
          return {
            ...item,
            filePath: "",
            thumbSrc: "",
          };
        }
      }),
    );
    const storyboardIds = resolvedStoryboardData.map((item) => item.id).filter(Boolean);
    const storyboardAssetRows = storyboardIds.length
      ? await u
          .db("o_assets2Storyboard")
          .whereIn("storyboardId", storyboardIds)
          .orderBy("storyboardId", "asc")
          .orderBy("rowid", "asc")
      : [];

    const assets2StoryboardMap: Record<number, number[]> = {};
    storyboardAssetRows.forEach((item) => {
      if (!assets2StoryboardMap[item.storyboardId!]) {
        assets2StoryboardMap[item.storyboardId!] = [];
      }
      assets2StoryboardMap[item.storyboardId!].push(item.assetId!);
    });

    const mappedStoryboard = resolvedStoryboardData
      .map((item) => ({
        id: item.id,
        index: item.index,
        duration: item.duration ? +item.duration : 0,
        prompt: item.prompt,
        associateAssetsIds: assets2StoryboardMap[item.id!] ?? [],
        src: item.filePath,
        thumbSrc: item.thumbSrc || item.filePath,
        state: item.state,
        track: item.track,
        trackId: item.trackId,
        videoDesc: item.videoDesc,
        shotMeta: parseShotMeta(item.shotMeta, {
          videoDesc: item.videoDesc,
          duration: item.duration,
          sourceShotNo: item.index != null ? Number(item.index) + 1 : null,
        }),
        shouldGenerateImage: item.shouldGenerateImage,
        reason: item?.reason ?? "",
        flowId: item.flowId,
      }))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    if (!sqlData) {
        const flowData: FlowData = {
          script: scriptData?.content ?? "",
          scriptPlan: "",
          shotPlan: null,
          shotPolicy: null,
          targetDuration: null,
          targetDurationSource: null,
          scriptTargetDuration: null,
          scriptTargetDurationSource: null,
          scriptTargetDurationRaw: null,
          assets: await Promise.all(
          assetsData.map(async (item) => {
            const assetImage = await resolveAssetImage(item.filePath);

            return {
              id: item.id,
              name: item.name ?? "",
              type: item.type ?? "",
              prompt: item.prompt ?? "",
              desc: item.describe ?? "",
              src: assetImage.src,
              thumbSrc: assetImage.thumbSrc,
              volcengineAssetUri: item.volcengineAssetUri ?? null,
              voiceProfile: item.voiceProfile ?? null,
              voiceTone: item.voiceTone ?? null,
              speechRate: item.speechRate ?? null,
              state: item.state ?? "未生成",
              errorReason: item?.errorReason ?? "",
              derive: await Promise.all(
                childAssetsData
                  .filter((child) => child.assetsId === item.id)
                  .map(async (child) => {
                    const childImage = await resolveAssetImage(child.filePath);

                    return {
                      id: child.id,
                      assetsId: item.id,
                      name: child.name ?? "",
                      type: child.type,
                      prompt: child.prompt,
                      desc: child.describe ?? "",
                      src: childImage.src,
                      thumbSrc: childImage.thumbSrc,
                      volcengineAssetUri: child.volcengineAssetUri ?? item.volcengineAssetUri ?? null,
                      voiceProfile: child.voiceProfile ?? item.voiceProfile ?? null,
                      voiceTone: child.voiceTone ?? item.voiceTone ?? null,
                      speechRate: child.speechRate ?? item.speechRate ?? null,
                      state: child.state ?? "未生成",
                    };
                  }),
              ),
            };
          }),
        ),
        storyboardTable: "",
        storyboard: mappedStoryboard as any,
        //todo：矫正workbench数据
        //@ts-ignore
        workbench: {
          name: "",
          duration: "",
          resolution: "",
          fps: "",
          videoList: [],
        },
      };
      return res.status(200).send(success(flowData));
    } else {
      try {
        const flowData = JSON.parse(sqlData!.data ?? "{}");
        const latestScriptContent = scriptData?.content ?? "";
        if (flowData.script !== latestScriptContent) {
          flowData.script = latestScriptContent;
          flowData.scriptSyncedAt = Date.now();
          await syncProductionScriptToWorkData({ projectId, scriptId: episodesId, content: latestScriptContent });
        }
        flowData.assets = await Promise.all(
          assetsData.map(async (item) => {
            const assetImage = await resolveAssetImage(item.filePath);

            return {
              id: item.id,
              name: item.name ?? "",
              type: item.type ?? "",
              prompt: item.prompt ?? "",
              desc: item.describe ?? "",
              src: assetImage.src,
              thumbSrc: assetImage.thumbSrc,
              volcengineAssetUri: item.volcengineAssetUri ?? null,
              voiceProfile: item.voiceProfile ?? null,
              voiceTone: item.voiceTone ?? null,
              speechRate: item.speechRate ?? null,
              state: item.state ?? "未生成",
              errorReason: item?.errorReason ?? "",
              flowId: item.flowId,
              derive: await Promise.all(
                childAssetsData
                  .filter((child) => child.assetsId === item.id)
                  .map(async (child) => {
                    const childImage = await resolveAssetImage(child.filePath);

                    return {
                      id: child.id,
                      assetsId: item.id,
                      name: child.name ?? "",
                      prompt: child.prompt,
                      type: child.type,
                      desc: child.describe ?? "",
                      src: childImage.src,
                      thumbSrc: childImage.thumbSrc,
                      volcengineAssetUri: child.volcengineAssetUri ?? item.volcengineAssetUri ?? null,
                      voiceProfile: child.voiceProfile ?? item.voiceProfile ?? null,
                      voiceTone: child.voiceTone ?? item.voiceTone ?? null,
                      speechRate: child.speechRate ?? item.speechRate ?? null,
                      state: child.state ?? "未生成",
                      errorReason: child?.errorReason ?? "",
                      flowId: child.flowId,
                    };
                  }),
              ),
            };
          }),
        );
        flowData.storyboard = mappedStoryboard;
        if (flowData.shotPlan === undefined) flowData.shotPlan = null;
        if (flowData.shotPolicy === undefined) flowData.shotPolicy = null;
        if (flowData.targetDuration === undefined) flowData.targetDuration = null;
        if (flowData.targetDurationSource === undefined) flowData.targetDurationSource = null;
        if (flowData.scriptTargetDuration === undefined) flowData.scriptTargetDuration = null;
        if (flowData.scriptTargetDurationSource === undefined) flowData.scriptTargetDurationSource = null;
        if (flowData.scriptTargetDurationRaw === undefined) flowData.scriptTargetDurationRaw = null;
        res.status(200).send(success(flowData));
      } catch (err) {
        res.status(400).send(error());
      }
    }
  },
);
