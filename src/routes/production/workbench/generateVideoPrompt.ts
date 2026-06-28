import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  formatVideoDurationRange,
  isGrokImagineVideo15PreviewModel,
  isSeedance2VideoModel,
  isGrokImagineVideoModel,
  normalizeStoryboardDuration,
  resolveVideoModelDurationRange,
  resolveGrokVideoDuration,
} from "@/utils/storyboardTrack";
import {
  grokImagineVideoPromptSection,
  patchVideoPromptGenerationSeedance2Section,
  seedance2PromptSection,
} from "@/lib/videoPromptGenerationSeedance2Patch";
import { resolveEffectiveAssetReferences, resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { mediaPromptSafetyInstruction } from "@/utils/promptSafety";
import { normalizeStoryboardShotMeta } from "@/utils/storyboardShotMeta";
import { ensureMandarinDialogueLanguageRule, renderMandarinDialogueLanguageRule } from "@/utils/videoPromptDialogueLanguage";
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

function extractDialogueFromVideoDesc(videoDesc?: string | null) {
  const text = normalizeText(videoDesc);
  const match = text.match(/台词[：:]\s*(.*?)(?:音效[：:]|关联资产(?:ID)?[：:]|$)/);
  const dialogue = normalizeText(match?.[1] || "");
  if (!dialogue || /^无(?:台词|对白|配音)?[。.!！]?$/i.test(dialogue)) return "";
  return dialogue.replace(/[。；;]\s*$/, "");
}

function splitLegacyVideoDescParts(videoDesc?: string | null) {
  const text = normalizeText(videoDesc).replace(/^（|）$/g, "");
  return text.split("、").map((item) => normalizeText(item)).filter(Boolean);
}

function extractMarkedVideoDescField(videoDesc: string | null | undefined, field: string, nextFields: string[]) {
  const text = normalizeText(videoDesc);
  const nextPattern = nextFields.map((item) => `${item}[：:]`).join("|");
  const pattern = new RegExp(`${field}[：:]\\s*(.*?)(?:${nextPattern ? nextPattern + "|" : ""}$)`);
  return normalizeText(text.match(pattern)?.[1] || "");
}

function extractStoryboardEmotion(videoDesc?: string | null) {
  const marked = extractMarkedVideoDescField(videoDesc, "情绪", ["光影", "台词", "音效", "关联资产", "关联资产ID"]);
  if (marked) return marked;
  return splitLegacyVideoDescParts(videoDesc)[7] || "";
}

function extractStoryboardPlotBeat(videoDesc?: string | null) {
  const picture = extractMarkedVideoDescField(videoDesc, "画面描述", ["场景", "资产", "关联资产", "时长"]);
  const action = extractMarkedVideoDescField(videoDesc, "动作", ["情绪", "光影", "台词", "音效"]);
  const dialogue = extractDialogueFromVideoDesc(videoDesc);
  if (picture || action || dialogue) return normalizeText([picture, action, dialogue].filter(Boolean).join("；"));

  const parts = splitLegacyVideoDescParts(videoDesc);
  return normalizeText([parts[0], parts[6], parts[9]].filter(Boolean).join("；"));
}

function buildBgmCue(items: any[], english: boolean) {
  const emotions = uniqueText(items.map((item) => extractStoryboardEmotion(item.videoDesc)).filter(Boolean)).slice(0, 5);
  const plotBeats = uniqueText(items.map((item) => extractStoryboardPlotBeat(item.videoDesc)).filter(Boolean)).slice(0, 3);
  const emotionText = emotions.length ? emotions.join(" -> ") : english ? "the current story mood" : "当前剧情情绪";
  const plotText = plotBeats.length ? plotBeats.join("；").slice(0, 180) : english ? "the current scene progression" : "当前分镜情节推进";

  if (english) {
    return `Background music/BGM: non-lyrical background score matching the plot mood (${emotionText}) and story beat (${plotText}); low volume under Mandarin dialogue and key sound effects, with subtle rise and fall following the emotional turn.`;
  }
  return `BGM/背景音乐: 根据剧情情绪（${emotionText}）和情节推进（${plotText}）选择无歌词背景配乐，音量低于中文对白、环境音和关键音效，随情绪转折自然增强或回落。`;
}

function ensureBgmCue(prompt: string, items: any[], english: boolean) {
  const text = compactPromptText(prompt);
  if (/(?:\bBGM\b|Background music|背景音乐|配乐)/i.test(text)) return text;
  return compactPromptText([text, buildBgmCue(items, english)].filter(Boolean).join("\n\n"));
}

function countDialogueChars(value?: string | null) {
  return normalizeText(value)
    .replace(/(?:^|[；;。.!！?？])[^；;。.!！?？：:]{1,16}[：:]/g, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
}

function parseStoredShotMeta(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStoredShotMeta(value: unknown, input: { videoDesc?: string | null; duration?: number | string | null }) {
  const parsed = parseStoredShotMeta(value);
  if (!parsed) return null;
  return normalizeStoryboardShotMeta(parsed, input);
}

function buildLowDialogueHandlingPlan(items: any[]) {
  return items
    .flatMap((item, index) => {
      const duration = normalizeStoryboardDuration(item.duration);
      const dialogue = extractDialogueFromVideoDesc(item.videoDesc);
      const charCount = countDialogueChars(dialogue);
      const minChars = Math.ceil(duration * 2);
      const maxChars = Math.ceil(duration * 3);
      if (!duration || charCount >= minChars) return [];
      return [
        {
          no: index + 1,
          id: item.id,
          duration,
          charCount,
          targetMinChars: minChars,
          targetMaxChars: maxChars,
          supplementMinChars: Math.max(0, minChars - charCount),
          existingDialogue: dialogue || "无台词",
          videoDesc: normalizeText(item.videoDesc).slice(0, 220),
        },
      ];
    });
}

function renderLowDialogueHandlingPlan(rows: any[]) {
  if (!rows.length) return "无";
  return rows
    .map((row) => {
      return [
        `${row.no}. storyboardId=${row.id}`,
        `duration=${formatDuration(row.duration)}s`,
        `当前台词字数=${row.charCount}`,
        `目标有效台词=${row.targetMinChars}-${row.targetMaxChars}个中文字符`,
        `至少补充=${row.supplementMinChars}个中文字符`,
        `现有台词=${row.existingDialogue}`,
        "处理方式=按剧情补充中文普通话对白、内心OS或画外音；普通对白需口型同步，OS/VO嘴部不动；不得改写已有台词、不得加字幕",
        `剧情依据=${row.videoDesc}`,
      ].join("；");
    })
    .join("\n");
}

function uniqueText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeText).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function renderRequiredDialogueAppendix(lines: string[]) {
  return renderMandarinDialogueLanguageRule(lines);
}

function ensureRequiredDialogueLines(prompt: string, requiredLines: string[]) {
  const missing = uniqueText(requiredLines).filter((line) => !String(prompt || "").includes(line));
  if (!missing.length) return compactPromptText(prompt);
  return compactPromptText([prompt, renderRequiredDialogueAppendix(missing)].filter(Boolean).join("\n\n"));
}

function limitGrokGeneratedPrompt(value: string, requiredLines: string[] = []) {
  const compacted = compactPromptText(value);
  const withRequiredDialogue = ensureRequiredDialogueLines(compacted, requiredLines);
  if (withRequiredDialogue.length <= MAX_GROK_GENERATED_PROMPT_LENGTH) return withRequiredDialogue;

  const appendix = renderRequiredDialogueAppendix(requiredLines);
  if (appendix) {
    const separator = "\n\n";
    const bodyLength = MAX_GROK_GENERATED_PROMPT_LENGTH - appendix.length - separator.length;
    if (bodyLength > 200) {
      return compactPromptText(`${withRequiredDialogue.slice(0, bodyLength).trimEnd()}${separator}${appendix}`);
    }
  }

  const marker = "\n...[compressed for Grok 4096 character limit]...\n";
  const headLength = 2600;
  const tailLength = MAX_GROK_GENERATED_PROMPT_LENGTH - headLength - marker.length;
  return `${withRequiredDialogue.slice(0, headLength).trimEnd()}${marker}${withRequiredDialogue.slice(-tailLength).trimStart()}`;
}

function enforceSingleGrokReferencePrompt(value: string) {
  let text = compactPromptText(value);
  text = text.replace(/^Reference mapping:[^\n]*/im, "Reference mapping: @图1 = the only uploaded storyboard frame reference.");
  text = text.replace(/@图\s*[2-9]\d*/g, "@图1");
  text = text.replace(/@image\s*[2-9]\d*/gi, "@图1");
  text = text.replace(/\bprovided reference images\b/gi, "provided reference image");
  text = text.replace(/\breference images\b/gi, "reference image");
  return text;
}

function enforceGrokTargetDurationPrompt(value: string, targetDuration: number) {
  const duration = formatDuration(targetDuration);
  const requiredPrefix = `A ${duration}-second cinematic video clip.`;
  const text = compactPromptText(value);
  if (!text) return requiredPrefix;
  if (/^A\s+\d+(?:\.\d+)?-second cinematic video clip\./i.test(text)) {
    return text.replace(/^A\s+\d+(?:\.\d+)?-second cinematic video clip\./i, requiredPrefix);
  }
  return `${requiredPrefix} ${text}`;
}

function normalizeVolcengineAssetUri(value?: string | null): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.startsWith("asset://") ? normalized : `asset://${normalized}`;
}

function normalizeText(value?: string | null) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatAssetVoiceHint(asset: any) {
  if (asset.type !== "role") return "";
  const parts = [
    normalizeText(asset.voiceProfile) ? `声线=${normalizeText(asset.voiceProfile)}` : "",
    normalizeText(asset.voiceTone) ? `语气=${normalizeText(asset.voiceTone)}` : "",
    normalizeText(asset.speechRate) ? `语速=${normalizeText(asset.speechRate)}` : "",
  ].filter(Boolean);
  return parts.length ? `,${parts.join(",")}` : "";
}

function isRoleAsset(asset: any) {
  return String(asset?.type || "") === "role";
}

function formatDetailedVoiceSetting(asset: any) {
  if (!isRoleAsset(asset)) return "";
  const name = normalizeText(asset.baseName) || normalizeText(asset.name) || (asset.id != null ? `角色${asset.id}` : "");
  if (!name) return "";

  const voiceProfile = normalizeText(asset.voiceProfile) || "未提供，按角色年龄、身份、性格和画面气质合理推断";
  const voiceTone = normalizeText(asset.voiceTone) || "未提供，按当前剧情情绪逐句细化";
  const speechRate = normalizeText(asset.speechRate) || "未提供，按台词长短、情绪强度和动作节奏自然调整";
  return `[${name}] 声线=${voiceProfile}，默认语气=${voiceTone}，默认语速=${speechRate}；每句台词都要补充情绪、音量、气息、停顿、重音和口型同步。`;
}

function buildVoiceSettingsContent(rows: any[]) {
  const map = new Map<string, string>();
  for (const item of rows) {
    const line = formatDetailedVoiceSetting(item);
    if (!line) continue;
    const key = normalizeText(item.baseName) || normalizeText(item.name) || String(item.id || line);
    if (!map.has(key)) map.set(key, line);
  }
  return Array.from(map.values()).join("；");
}

function selectSingleStoryboardInfo<T extends { id: number; sources: string }>(info: T[]): T[] {
  const validInfo = info.filter((item) => item?.id != null);
  const storyboardInfo = validInfo.find((item) => item.sources === "storyboard");
  const selected = storyboardInfo ?? validInfo[0];
  return selected ? [selected] : [];
}

function selectStoryboardTextInfo<T extends { id: number; sources: string }>(info: T[]): T[] {
  return info.filter((item) => item?.id != null && item.sources === "storyboard");
}

async function getTrackStoryboardTextInfo(trackId: number) {
  const rows = await u.db("o_storyboard").where("trackId", trackId).orderBy("index", "asc").select("id");
  return rows.map((row: any) => ({ id: Number(row.id), sources: "storyboard" }));
}

function resolveEffectivePromptModel(requestModel: string, projectModel?: string | null) {
  const requested = normalizeText(requestModel);
  const projectConfigured = normalizeText(projectModel);
  if (!requested) return projectConfigured;
  return requested;
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
        referenceImageKind: z.enum(["storyboard", "grid", "tailFrame"]).optional(),
      }),
    ),
    model: z.string(),
    duration: z.number().optional(),
  }),
  async (req, res) => {
    const { trackId, projectId, info, model, duration } = req.body;
    const projectData = await u.db("o_project").select("*").where({ id: projectId }).first();
    const effectiveModel = resolveEffectivePromptModel(model, projectData?.videoModel);
    const forceSingleStoryboardReference = isGrokImagineVideo15PreviewModel(effectiveModel);
    const selectedSingleStoryboard = forceSingleStoryboardReference ? selectSingleStoryboardInfo(info)[0] : undefined;
    const trackStoryboardTextInfo = forceSingleStoryboardReference ? await getTrackStoryboardTextInfo(trackId) : [];
    const effectiveInfo = forceSingleStoryboardReference
      ? (trackStoryboardTextInfo.length ? trackStoryboardTextInfo : selectStoryboardTextInfo(info))
      : info;
    //查询参数
    const images = await Promise.all(
      effectiveInfo.map(async (item: { id: number; sources: string }) => {
        if (item.sources === "storyboard") {
          // 查询分镜主信息
          const storyboard = await u
            .db("o_storyboard")
            .where("o_storyboard.id", item.id)
            .select("videoDesc", "prompt", "track", "duration", "shouldGenerateImage", "shotMeta")
            .first();
          // 查询分镜关联的资产ID
          const storyboardAssets = await resolveEffectiveStoryboardAssetReferences([item.id]);
          const associateAssetsIds = forceSingleStoryboardReference ? [] : storyboardAssets.map((row) => row.id);
          return {
            id: item.id,
            ...storyboard,
            associateAssetsIds,
            voiceAssets: storyboardAssets.filter(isRoleAsset),
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
          baseName: item.baseName,
          filePath: item.filePath,
          volcengineAssetUri: normalizeVolcengineAssetUri(item.volcengineAssetUri || item.parentVolcengineAssetUri),
          voiceProfile: item.voiceProfile,
          voiceTone: item.voiceTone,
          speechRate: item.speechRate,
        });
      if (item._type === "storyboard")
        storyboard.push({
          id: item.id,
          videoDesc: item.videoDesc,
          prompt: forceSingleStoryboardReference && item.id !== selectedSingleStoryboard?.id ? "" : item.prompt,
          track: item.track,
          duration: item.duration,
          shotMeta: JSON.stringify(
            normalizeStoredShotMeta(item.shotMeta, {
              videoDesc: item.videoDesc,
              duration: item.duration,
            }) ?? {},
          ),
          associateAssetsIds: item.associateAssetsIds,
          shouldGenerateImage: item.shouldGenerateImage,
          voiceAssets: item.voiceAssets ?? [],
        });
    }
    const [id, modelData] = effectiveModel.split(/:(.+)/);
    const isSeedance2Video = isSeedance2VideoModel(effectiveModel, modelData);
    const isVolcengineSeedance2Video = id === "volcengine" && isSeedance2Video;
    const isLongxiaSeedance2Video = id === "longxia" && isSeedance2Video;
    const isGrokImagineVideo = isGrokImagineVideoModel(effectiveModel, modelData);
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
      .map((i) => `[${i.id},${i.type},${i.name}${isVolcengineSeedance2Video && i.volcengineAssetUri ? ",官方虚拟人像参考" : ""}${formatAssetVoiceHint(i)}]`)
      .join("，");
    const voiceSettingsContent = buildVoiceSettingsContent([...assets, ...storyboard.flatMap((i) => i.voiceAssets ?? [])]);
    const storyboardTotalDuration = storyboard.reduce((sum, item) => sum + normalizeStoryboardDuration(item.duration), 0);
    const requestedDuration = normalizeStoryboardDuration(duration) || storyboardTotalDuration;
    const grokDurationRange = isGrokImagineVideo ? resolveVideoModelDurationRange(effectiveModel, modelData) : null;
    const grokTargetDuration = isGrokImagineVideo ? resolveGrokVideoDuration(requestedDuration, effectiveModel, modelData) : 0;
    let durationStrategy = "";
    if (isSeedance2Video) {
      const seedanceTargetDuration = formatDuration(requestedDuration);
      durationStrategy = `
          **视频生成时长策略**：当前模型为 Seedance 2.x，视频时长使用分镜台当前选择的 ${seedanceTargetDuration}s。
          - 下方 <storyboardItem> 的 duration 保持分镜/轨道实际时长，优先使用 XML duration，不要使用 videoDesc 内部原始时长覆盖它。
          - 输出提示词中的所有时间段必须压缩/延展到总时长 ${seedanceTargetDuration}s。
          - 若分镜累计时长与 ${seedanceTargetDuration}s 不一致，可调整已有动作、情绪停顿、镜头推进、光影和环境细节；低对白/无台词分镜必须按剧情补充中文普通话对白、OS 或 VO 到每秒约 2-3 个中文字符。
          - 不新增角色、道具、场景或剧情结果；已有台词不得改写、翻译或省略。仅允许为低对白/无台词分镜补充符合当前剧情的中文普通话对白、OS 或 VO。
          `;
    } else if (isGrokImagineVideo) {
      durationStrategy = `
          **视频生成时长策略**：当前模型为 Grok Imagine Video，接口支持 ${formatVideoDurationRange(grokDurationRange!)} 范围内的视频时长。
          - 本次 Grok 提交时长为 ${grokTargetDuration} 秒；该值由分镜台当前选择 ${formatDuration(requestedDuration)} 秒按模型范围夹取得到。
          - 下方 <storyboardItem> 的 duration 保持分镜/轨道原始时长，不再按固定目标秒数重新分配；优先使用 XML duration 理解原始节奏。
          - 输出提示词第一行必须写成 "A ${grokTargetDuration}-second cinematic video clip."，禁止出现任何非 ${grokTargetDuration} 秒的时长。
          - 多条 storyboardItem 必须压缩成一个连续 ${grokTargetDuration} 秒视频，不要输出多个独立分镜段落。
          - 若原始累计时长与 ${grokTargetDuration} 秒不一致，可在最终提交时长内压缩/延展已有动作、情绪停顿、镜头推进、光影和环境细节；低对白/无台词分镜必须按剧情补充中文普通话对白、OS 或 VO 到每秒约 2-3 个中文字符。
          - 不新增角色、道具、场景或剧情结果；已有台词不得改写、翻译或省略。仅允许为低对白/无台词分镜补充符合当前剧情的中文普通话对白、OS 或 VO。
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
          ${
            forceSingleStoryboardReference
              ? `- 当前模型为 Grok Imagine Video 1.5 Preview 单图模式：本次只上传 1 张分镜图参考，且只能写 @图1。
          - @图1 必须定义为“the selected storyboard frame / the only uploaded reference image”，禁止把角色、道具、场景拆成 @图2、@图3 或更多参考图。
          - 即使只上传 1 张视觉参考图，也必须完整阅读下方所有 storyboardItem 的 videoDesc；这些 storyboardItem 属于同一条视频轨道，台词、动作和情绪都必须进入最终提示词。
          - 全文禁止出现 @图2、@图3、@image2、@image3、Reference mapping 中也只能有 @图1。
          - 不要输出“provided reference images”或“reference images”复数，统一写 “the provided reference image”。
          - 角色声线、语气、语速只能作为文字表演设定写进 dialogue/audio/performance，禁止把它们变成新的图片引用。`
              : `- 必须按当前参考图上传顺序使用 @图N：@图1 对应第 1 张输入参考图，@图2 对应第 2 张输入参考图，依此类推。
          - 可以输出英文 "Reference mapping:" 说明 @图N 对应的角色、场景、道具或分镜构图；禁止输出中文“参考定义/图片定义”模板。
          - 不要引用未上传的 @图N，不要用一个 @图N 代替多个角色/场景/道具。`
          }
          - 将所有 storyboardItem 整合为一个连续 ${grokTargetDuration} 秒镜头；time beats 可参考各 storyboardItem 的原始 duration，但不能写“分镜1/分镜2”列表。
          - 必须覆盖所有 storyboardItem 中的既有台词；不能因为单图参考只选中第一张分镜而忽略后续分镜台词。无台词/少台词片段必须按剧情补充中文普通话对白、OS 或 VO 到每秒约 2-3 个中文字符，画面描述可英文，但 spoken line 必须中文。
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
  duration='${escapeXmlAttr(i.duration)}'
  shotMeta='${escapeXmlAttr(i.shotMeta || "")}'
  associateAssetsIds='${escapeXmlAttr(JSON.stringify(i.associateAssetsIds ?? []))}'
  shouldGenerateImage='${escapeXmlAttr(i.shouldGenerateImage)}'
></storyboardItem>`,
      )
      .join("\n");
    const requiredDialogueLines = uniqueText(storyboard.map((item) => extractDialogueFromVideoDesc(item.videoDesc)).filter(Boolean));
    const lowDialogueHandlingPlan = buildLowDialogueHandlingPlan(storyboard);
    console.log(
      `[generateVideoPrompt] trackId=${trackId} requestModel=${model || "-"} projectModel=${projectData?.videoModel || "-"} effectiveModel=${effectiveModel || "-"} isGrok=${isGrokImagineVideo} isGrok15=${forceSingleStoryboardReference} requestedDuration=${requestedDuration}s target=${grokTargetDuration || requestedDuration}s sourceDuration=${storyboardTotalDuration}s dialogueLines=${requiredDialogueLines.length} lowDialogue=${lowDialogueHandlingPlan.length}`,
    );
    const content = `
	          **模型名称**：${modelData},
            ${modelModeInstruction}
            ${durationStrategy}
            ${forceSingleStoryboardReference ? "**单图参考硬约束**：当前请求只会上传 1 张分镜图作为 @图1。生成结果必须完全基于该分镜图，不得把资产信息、角色、道具、场景或 associateAssetsIds 转写为额外 @图 引用。\n" : ""}
            **角色声音规则**：资产信息中若包含 声线/语气/语速，生成视频提示词时必须把对应角色的声音设定写入 audio/dialogue/voice performance 描述；中文台词仍必须用普通话逐字说出，不得把台词做成字幕。
            **角色声音设定（纯文本约束，不是参考图）**：${voiceSettingsContent || "未提供明确声线；仍需根据角色年龄、身份、情绪和剧情合理补充每句台词的语气、语速、停顿与口型同步。"}
            **BGM 硬约束**：
            - 每个最终视频提示词必须包含 BGM/背景音乐/Background music 描述，不能省略。
            - BGM 必须根据下方分镜的剧情情节、情绪字段、角色动作强度和台词语气生成，写清配乐气质、节奏、音量层级和情绪起伏。
            - BGM 必须无歌词，音量低于中文对白、环境音和关键动作音效，不要遮盖台词；不要只写“合适的BGM”这类空泛描述。
            - Seedance/中文模板使用「BGM/背景音乐: ...」；Grok/英文模板使用「Background music/BGM: ...」。
            **BGM 自动补充参考**：${buildBgmCue(storyboard, isGrokImagineVideo)}
            **台词表演硬约束**：
            - 分镜已有台词必须保留完整中文原文，不翻译、不改写、不省略；这些台词优先级最高。
            - 最终 prompt 中所有会被朗读、配音、口型同步的台词/旁白/OS/VO 都必须是中文普通话；英文只能用于画面、镜头、动作和技术说明，禁止作为 spoken line。
            - 低对白/无台词分镜必须按剧情补充中文普通话对白、内心OS或画外音，使有效台词接近每秒 2-3 个中文字符；补充内容只能服务当前剧情、动作、冲突和情绪，不得新增角色、道具、场景或剧情结果。
            - 允许补充台词不等于改写台词：已有台词、OS、VO、旁白或系统播报必须原样保留；补充台词不得覆盖、替换或削弱原文。
            - 每句已有台词都要写出 speaker、台词类型（dialogue/OS/VO）、声线/音色、当句情绪、语气、语速、停顿/气息、音量/重音、口型同步状态。
            - 普通对白必须明确 mouth/lip sync active；内心OS、画外音或无台词角色必须明确 mouth closed / no lip movement。
            - 台词较长时允许加快但必须清晰，不得丢词；只有剧情明确需要保持沉默时，才写静默表演和嘴部不动。
            **安全表达硬约束**：${mediaPromptSafetyInstruction()}
            **必须原样保留的台词清单**：${requiredDialogueLines.length ? requiredDialogueLines.map((line, index) => `${index + 1}. ${line}`).join("；") : "无台词"}
            **对白语言最终规则**：
${renderMandarinDialogueLanguageRule(requiredDialogueLines)}
            **低对白/无台词分镜补词清单（必须按剧情补中文台词/OS/VO）**：
${renderLowDialogueHandlingPlan(lowDialogueHandlingPlan)}
	          **资产信息**（角色、场景、道具):${forceSingleStoryboardReference ? "当前为单图模式，不上传独立角色/场景/道具资产图；只能把 @图1 当作唯一视觉参考。" : assetsContent},
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
      const normalizedText = forceSingleStoryboardReference ? enforceSingleGrokReferencePrompt(text) : text;
      const durationAlignedText = isGrokImagineVideo ? enforceGrokTargetDurationPrompt(normalizedText, grokTargetDuration) : normalizedText;
      const bgmAlignedText = ensureBgmCue(durationAlignedText, storyboard, isGrokImagineVideo);
      const dialogueLanguageAlignedText = ensureMandarinDialogueLanguageRule(bgmAlignedText, requiredDialogueLines);
      const finalText = isGrokImagineVideo ? limitGrokGeneratedPrompt(dialogueLanguageAlignedText, requiredDialogueLines) : dialogueLanguageAlignedText;
      await u.db("o_videoTrack").where({ id: trackId }).update({
        prompt: finalText,
      });
      res.status(200).send(success(finalText));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
