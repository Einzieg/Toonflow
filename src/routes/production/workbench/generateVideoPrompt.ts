import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  getGrokVideoSupportedDurations,
  isSeedance2VideoModel,
  isGrokImagineVideoModel,
  normalizeStoryboardDuration,
  resolveGrokVideoDuration,
} from "@/utils/storyboardTrack";
import {
  grokImagineVideoPromptSection,
  patchVideoPromptGenerationSeedance2Section,
  seedance2PromptSection,
} from "@/lib/videoPromptGenerationSeedance2Patch";
import { resolveEffectiveAssetReferences, resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
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

const MAX_GROK_GENERATED_PROMPT_LENGTH = 3600;

function compactPromptText(value: string) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function limitGrokGeneratedPrompt(value: string) {
  const compacted = compactPromptText(value);
  if (compacted.length <= MAX_GROK_GENERATED_PROMPT_LENGTH) return compacted;

  const marker = "\n...[compressed for Grok 4096 character limit]...\n";
  const headLength = 2600;
  const tailLength = MAX_GROK_GENERATED_PROMPT_LENGTH - headLength - marker.length;
  return `${compacted.slice(0, headLength).trimEnd()}${marker}${compacted.slice(-tailLength).trimStart()}`;
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
          const associateAssetsIds = (await resolveEffectiveStoryboardAssetReferences([item.id])).map((row) => row.id);
          return {
            ...storyboard,
            associateAssetsIds,
            _type: "storyboard", // 标记类型，便于后续区分
          };
        }
        if (item.sources === "assets") {
          // 查询素材
          const [assetsData] = await resolveEffectiveAssetReferences([item.id]);
          if (!assetsData) return null;
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
    const isSeedance2Video = isSeedance2VideoModel(model, modelData);
    const isVolcengineSeedance2Video = id === "volcengine" && isSeedance2Video;
    const isLongxiaSeedance2Video = id === "longxia" && isSeedance2Video;
    const isGrokImagineVideo = isGrokImagineVideoModel(model, modelData);
    const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
    const videoPrompt = await u.db("o_prompt").where("type", "videoPromptGeneration").first();
    let videoPromptGeneration = "" as string | undefined;
    if (videoPrompt && videoPrompt.useData) {
      videoPromptGeneration = videoPrompt.useData;
    } else {
      videoPromptGeneration = videoPrompt?.data ?? undefined;
    }
    videoPromptGeneration = patchVideoPromptGenerationSeedance2Section(videoPromptGeneration || "") || "";
    const artStyle = projectData?.artStyle || "无";
    const visualManual = u.getArtPrompt(artStyle, "art_skills", "art_storyboard_video");
    const assetsContent = assets
      .filter((i) => i.filePath || (isVolcengineSeedance2Video && i.volcengineAssetUri))
      .map((i) => `[${i.id},${i.type},${i.name}${isVolcengineSeedance2Video && i.volcengineAssetUri ? ",官方虚拟人像参考" : ""}]`)
      .join("，");
    const storyboardTotalDuration = storyboard.reduce((sum, item) => sum + normalizeStoryboardDuration(item.duration), 0);
    const grokSupportedDurations = isGrokImagineVideo ? getGrokVideoSupportedDurations(model, modelData) : [];
    const grokTargetDuration = isGrokImagineVideo ? resolveGrokVideoDuration(storyboardTotalDuration, model, modelData) : 0;
    const promptDurations = isGrokImagineVideo ? distributeFixedDuration(storyboard, grokTargetDuration) : [];
    let durationStrategy = "";
    if (isSeedance2Video) {
      const seedanceTargetDuration = formatDuration(storyboardTotalDuration);
      durationStrategy = `
          **视频生成时长策略**：当前模型为 Seedance 2.x，视频时长使用当前轨道累计时长，不再固定补足到 15 秒。
          - 下方 <storyboardItem> 的 duration 保持分镜/轨道实际时长，优先使用 XML duration，不要使用 videoDesc 内部原始时长覆盖它。
          - 输出提示词中的所有「分镜N {N}s」时长相加必须严格等于当前轨道累计 ${seedanceTargetDuration}s，且不得超过 15s。
          - 若当前轨道累计不足 15s，不要强行延展到 15s；只按已有 duration 写动作、情绪停顿、镜头推进、光影和环境细节。
          - 不新增角色、道具、场景、台词或剧情结果。
          `;
    } else if (isGrokImagineVideo) {
      durationStrategy = `
          **视频生成时长策略**：当前模型为 Grok Imagine Video，接口只支持 ${grokSupportedDurations.join(" 秒或 ")} 秒。
          - 本次 Grok 目标时长为 ${grokTargetDuration} 秒；下方 <storyboardItem> 的 duration 已按 ${grokTargetDuration} 秒重新分配，优先使用 XML duration。
          - 输出提示词第一行必须写成 "A ${grokTargetDuration}-second cinematic video clip."，禁止出现任何非 ${grokTargetDuration} 秒的时长。
          - 多条 storyboardItem 必须压缩成一个连续 ${grokTargetDuration} 秒视频，不要输出多个独立分镜段落。
          - 若原始累计时长与 ${grokTargetDuration} 秒不一致，只允许压缩/延展已有动作、情绪停顿、镜头推进、光影和环境细节，不新增角色、道具、场景、台词或剧情结果。
          `;
    }
    let modelModeInstruction = "";
    if (isSeedance2Video) {
      modelModeInstruction = `
          **强制提示词模式**：Seedance 2.0 多参模式，必须使用改进版 Seedance 2.0 模板。
          - 第一行必须是「画面风格和类型:」。
          - 必须先输出「参考定义:」，再输出「生成一个由以下 N 个分镜组成的视频:」。
          ${isLongxiaSeedance2Video ? "- 当前平台为 LongXia，引用标签必须按接口规则输出：参考图用 @imageN，参考音频用 @audioN，参考视频用 @videoN，各媒体类型独立编号；不要输出 @图N。\n          " : ""}
          - 每个分镜必须写出动态递进，优先使用「先/随后/最后」组织动作、镜头、神态变化。
          - 禁止回退到旧版静态短句模板，禁止只复述 videoDesc 或静态 prompt。
          - 下方提供的 Seedance 2.0 规则优先级高于通用规则：
${seedance2PromptSection}
          `;
    } else if (isGrokImagineVideo) {
      modelModeInstruction = `
          **强制提示词模式**：Grok Imagine Video，必须使用 Grok 单段视频模板。
          - 第一行必须是 "A ${grokTargetDuration}-second cinematic video clip."。
          - 直接输出英文视频提示词正文，不输出中文模板标题、Markdown、XML、模型匹配说明或分析过程。
          - 必须按当前参考图上传顺序使用 @图N：@图1 对应第 1 张输入参考图，@图2 对应第 2 张输入参考图，依此类推。
          - 可以输出英文 "Reference mapping:" 说明 @图N 对应的角色、场景、道具或分镜构图；禁止输出中文“参考定义/图片定义”模板。
          - 不要引用未上传的 @图N，不要用一个 @图N 代替多个角色/场景/道具。
          - 将所有 storyboardItem 压缩为一个连续 ${grokTargetDuration} 秒镜头，可写 time beats，但不能写“分镜1/分镜2”列表。
          - 最终输出必须控制在 3200 个英文字符以内；Reference mapping、timeline、camera、performance、constraints 都要短句化，不要复制长段 storyboard 原文。
          - 下方 Grok 规则优先级高于通用规则：
${grokImagineVideoPromptSection}
          `;
    }
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
            ${modelModeInstruction}
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
      const finalText = isGrokImagineVideo ? limitGrokGeneratedPrompt(text) : text;
      await u.db("o_videoTrack").where({ id: trackId }).update({
        prompt: finalText,
      });
      res.status(200).send(success(finalText));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
