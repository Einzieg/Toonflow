import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { FIXED_SEEDANCE_VIDEO_DURATION_SECONDS, isFixedDurationSeedanceVideoModel, normalizeStoryboardDuration } from "@/utils/storyboardTrack";
const router = express.Router();

function escapeXmlAttr(value: unknown): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

function formatDuration(value: number): string {
  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function normalizeVolcengineAssetUri(value?: string | null): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.startsWith("asset://") ? normalized : `asset://${normalized}`;
}

function distributeFixedDuration(storyboard: Array<{ duration?: unknown }>, targetDuration: number): string[] {
  if (storyboard.length === 0) return [];
  const rawDurations = storyboard.map((item) => normalizeStoryboardDuration(item.duration as any));
  const rawTotal = rawDurations.reduce((sum, item) => sum + item, 0);
  if (rawTotal <= 0) {
    const average = targetDuration / storyboard.length;
    return storyboard.map((_, index) => formatDuration(index === storyboard.length - 1 ? targetDuration - average * (storyboard.length - 1) : average));
  }

  const durations = rawDurations.map((duration) => Number(((duration / rawTotal) * targetDuration).toFixed(1)));
  const total = durations.reduce((sum, item) => sum + item, 0);
  durations[durations.length - 1] = Number((durations[durations.length - 1] + (targetDuration - total)).toFixed(1));
  return durations.map(formatDuration);
}

export default router.post(
  "/",
  validateFields({
    trackId: z.number(),
    projectId: z.number(),
    info: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
    model: z.string(),
  }),
  async (req, res) => {
    const { trackId, projectId, info, model } = req.body;
    //查询参数
    const images = await Promise.all(
      info.map(async (item: { id: number; sources: string }) => {
        if (item.sources === "storyboard") {
          // 查询分镜主信息
          const storyboard = await u
            .db("o_storyboard")
            .where("o_storyboard.id", item.id)
            .select("videoDesc", "prompt", "track", "duration", "shouldGenerateImage")
            .first();
          // 查询分镜关联的资产ID
          const assetRows = await u.db("o_assets2Storyboard").where("storyboardId", item.id).orderBy("rowid").select("assetId");
          const associateAssetsIds = assetRows.map((row: any) => row.assetId);
          return {
            ...storyboard,
            associateAssetsIds,
            _type: "storyboard", // 标记类型，便于后续区分
          };
        }
        if (item.sources === "assets") {
          // 查询素材
          const assetsData = await u
            .db("o_assets")
            .leftJoin("o_image", "o_image.id", "o_assets.imageId")
            .leftJoin({ parentAsset: "o_assets" }, "o_assets.assetsId", "parentAsset.id")
            .where("o_assets.id", item.id)
            .select(
              "o_assets.id",
              "o_assets.type",
              "o_assets.name",
              "o_image.filePath",
              "o_assets.volcengineAssetUri",
              "parentAsset.volcengineAssetUri as parentVolcengineAssetUri",
            )
            .first();
          return {
            ...assetsData,
            _type: "assets", // 标记类型
          };
        }
      }),
    );

    // 拆分 assets 和 storyboard
    const assets: any[] = [];
    const storyboard: any[] = [];
    for (const item of images) {
      if (!item) continue; // 忽略空
      if (item._type === "assets")
        assets.push({
          id: item.id,
          type: item.type,
          name: item.name,
          filePath: item.filePath,
          volcengineAssetUri: normalizeVolcengineAssetUri(item.volcengineAssetUri || item.parentVolcengineAssetUri),
        });
      if (item._type === "storyboard")
        storyboard.push({
          videoDesc: item.videoDesc,
          prompt: item.prompt,
          track: item.track,
          duration: item.duration,
          associateAssetsIds: item.associateAssetsIds,
          shouldGenerateImage: item.shouldGenerateImage,
        });
    }
    const [id, modelData] = model.split(/:(.+)/);
    const isFixedDurationSeedance = isFixedDurationSeedanceVideoModel(model, modelData);
    const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
    const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
    let videoPromptGeneration = "" as string | undefined;
    if (videoPrompt && videoPrompt.useData) {
      videoPromptGeneration = videoPrompt.useData;
    } else {
      videoPromptGeneration = videoPrompt?.data ?? undefined;
    }
    const artStyle = projectData?.artStyle || "无";
    const visualManual = u.getArtPrompt(artStyle, "art_skills", "art_storyboard_video");
    const assetsContent = assets
      .filter((i) => i.filePath || (isFixedDurationSeedance && i.volcengineAssetUri))
      .map((i) => `[${i.id},${i.type},${i.name}${isFixedDurationSeedance && i.volcengineAssetUri ? ",官方虚拟人像参考" : ""}]`)
      .join("，");
    const promptDurations = isFixedDurationSeedance ? distributeFixedDuration(storyboard, FIXED_SEEDANCE_VIDEO_DURATION_SECONDS) : [];
    const durationStrategy = isFixedDurationSeedance
      ? `
          **视频生成时长策略**：当前模型为 Seedance 2.x，视频生成接口固定输出 ${FIXED_SEEDANCE_VIDEO_DURATION_SECONDS} 秒。
          - 下方 <storyboardItem> 的 duration 已按 ${FIXED_SEEDANCE_VIDEO_DURATION_SECONDS} 秒目标重新分配，优先使用 XML duration，不要使用 videoDesc 内部原始时长覆盖它。
          - 输出提示词中的所有「分镜N {N}s」时长相加必须严格等于 ${FIXED_SEEDANCE_VIDEO_DURATION_SECONDS}s。
          - 若原始分镜累计不足 ${FIXED_SEEDANCE_VIDEO_DURATION_SECONDS}s，只允许延展已有动作、情绪停顿、镜头推进、光影和环境细节来补足，不新增角色、道具、场景、台词或剧情结果。
          - 不要输出 4s、8s、10s、12s 等其他接口总时长；总时长只能是 ${FIXED_SEEDANCE_VIDEO_DURATION_SECONDS}s。
          `
      : "";
    const storyboardContent = storyboard
      .map(
        (i, index) => `<storyboardItem
  videoDesc='${escapeXmlAttr(i.videoDesc)}'
  prompt='${escapeXmlAttr(i.prompt)}'
  track='${escapeXmlAttr(i.track)}'
  duration='${escapeXmlAttr(promptDurations[index] ?? i.duration)}'
  associateAssetsIds='${escapeXmlAttr(JSON.stringify(i.associateAssetsIds ?? []))}'
  shouldGenerateImage='${escapeXmlAttr(i.shouldGenerateImage)}'
></storyboardItem>`,
      )
      .join("\n");
    const content = `
	          **模型名称**：${modelData},
            ${durationStrategy}
	          **资产信息**（角色、场景、道具):${assetsContent},
	          **分镜信息**：${storyboardContent},
	          `;

    try {
      const { text } = await u.Ai.Text("universalAi").invoke({
        system: videoPromptGeneration,
        messages: [
          {
            role: "assistant",
            content: `${visualManual}`,
          },
          {
            role: "user",
            content: content,
          },
        ],
      });
      await u.db("o_videoTrack").where({ id: trackId }).update({
        prompt: text,
      });
      res.status(200).send(success(text));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
