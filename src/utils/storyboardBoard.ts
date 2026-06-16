import crypto from "crypto";
import sharp from "sharp";
import u from "@/utils";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
import { resolveEffectiveStoryboardAssetReferences, type EffectiveAssetReference } from "@/utils/effectiveAssetReference";
import { getGrokVideoSupportedDurations, normalizeStoryboardDuration } from "@/utils/storyboardTrack";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";

export type StoryboardBoardLayout = "script" | "grid" | "vertical" | "horizontal";
export type StoryboardBoardRatio = "auto" | "16:9" | "9:16";
export const STORYBOARD_BOARD_FIXED_IMAGE_RATIO = "9:16" as const;

export interface StoryboardBoardInput {
  id?: number | null;
  index?: number | null;
  filePath?: string | null;
  duration?: number | string | null;
  prompt?: string | null;
  videoDesc?: string | null;
  track?: string | null;
}

export interface StoryboardBoardContext {
  projectId: number;
  scriptId: number;
  scriptContent?: string | null;
  projectName?: string | null;
  projectType?: string | null;
  artStyle?: string | null;
  directorManual?: string | null;
  imageModel: string;
  imageQuality?: "1K" | "2K" | "4K" | null;
  videoRatio?: "16:9" | "9:16" | null;
  ratio?: StoryboardBoardRatio;
  itemsPerBoard?: number | null;
  targetDuration?: number | null;
}

export interface StoryboardBoardImageResult {
  filePath: string;
  thumbPath: string;
  shotScript: string;
  imagePrompt: string;
  imageModel: string;
  targetDuration: number;
  sourceHash: string;
}

export interface StoryboardBoardSegmentPlan {
  storyboards: StoryboardBoardInput[];
  targetDuration: number;
  reason: string;
}

const MAX_SCRIPT_CONTENT_LENGTH = 5000;
const MAX_SHOT_SCRIPT_LENGTH = 6500;
const MAX_IMAGE_PROMPT_LENGTH = 3800;
const MAX_VIDEO_PROMPT_BYTES = 3000;
const MAX_STORYBOARDS_PER_BOARD = 8;
const MAX_STORYBOARD_BOARD_REFERENCES = 7;
const MAX_STORYBOARD_BOARD_SHOT_DURATION = 5;
const TEN_SECOND_STORYBOARD_MIN_SHOTS = 3;
const TEN_SECOND_STORYBOARD_MAX_SHOTS = 5;

function normalizeText(value?: string | number | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 18)).trim()}...（已截断）`;
}

function getUtf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function takeFirstUtf8Bytes(value: string, maxBytes: number) {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = getUtf8Bytes(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function takeLastUtf8Bytes(value: string, maxBytes: number) {
  let result = "";
  let bytes = 0;
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const charBytes = getUtf8Bytes(char);
    if (bytes + charBytes > maxBytes) break;
    result = char + result;
    bytes += charBytes;
  }
  return result;
}

function truncateTextByUtf8Bytes(value: string, maxBytes: number) {
  if (getUtf8Bytes(value) <= maxBytes) return value;
  const marker = "\n...[已按上游字节限制压缩]...\n";
  const markerBytes = getUtf8Bytes(marker);
  const headBytes = Math.min(1900, Math.max(0, maxBytes - markerBytes));
  const tailBytes = Math.max(0, maxBytes - headBytes - markerBytes);
  return `${takeFirstUtf8Bytes(value, headBytes).trimEnd()}${marker}${takeLastUtf8Bytes(value, tailBytes).trimStart()}`;
}

function storyboardLabel(item: StoryboardBoardInput, fallbackIndex: number) {
  return `S${String(Number(item.index ?? fallbackIndex) + 1).padStart(2, "0")}`;
}

function resolveAspectRatio(): typeof STORYBOARD_BOARD_FIXED_IMAGE_RATIO {
  return STORYBOARD_BOARD_FIXED_IMAGE_RATIO;
}

function buildStoryboardBoardFrameStyleLines(artStyle?: string | null) {
  const styleKey = String(artStyle || "");
  if (styleKey.startsWith("realpeople_")) {
    return [
      "每个镜头卡片的小画面框必须是项目画风下的影视预演帧/摄影分镜帧：真人实拍摄影质感、自然镜头光影、真实人物、服装、场景和材质。",
      "禁止把小画面框画成手绘草图、漫画分镜、概念线稿、3D、CGI、动画、卡通、黏土、玩偶或塑料模型感。",
    ];
  }
  if (styleKey.startsWith("3D_")) {
    return [
      "每个镜头卡片的小画面框必须是项目 3D 画风下的镜头预演帧：保持既定渲染、材质、光影和角色比例。",
      "禁止把小画面框改成真人摄影、手绘草图、漫画线稿、扁平插画或其它未选择风格。",
    ];
  }
  if (styleKey.startsWith("2D_")) {
    return [
      "每个镜头卡片的小画面框必须是项目 2D 画风下的分镜预演帧：保持既定线条、上色、构图和角色设计。",
      "禁止把小画面框改成真人摄影、3D、CGI、黏土、玩偶、游戏引擎或其它未选择风格。",
    ];
  }
  return [
    "每个镜头卡片的小画面框必须严格遵循项目当前画风，角色、场景、道具、光影和材质都不能漂移。",
    "禁止自行改成 3D、CGI、卡通、真人摄影、手绘草图或其它未选择风格。",
  ];
}

function normalizeTargetDuration(storyboards: StoryboardBoardInput[], targetDuration?: number | null) {
  const explicit = Number(targetDuration);
  if (Number.isFinite(explicit) && explicit > 0) return Number(explicit.toFixed(3));
  const total = storyboards.reduce((sum, item) => sum + normalizeStoryboardDuration(item.duration), 0);
  return Number(Math.max(1, total || 6).toFixed(3));
}

function resolveStoryboardShotPolicy(totalDuration: number) {
  const duration = Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : 6;
  const isTenSecondVideo = Math.abs(duration - 10) < 0.01;
  const minByDuration = Math.max(1, Math.ceil(duration / MAX_STORYBOARD_BOARD_SHOT_DURATION));
  const minShots = isTenSecondVideo ? Math.max(TEN_SECOND_STORYBOARD_MIN_SHOTS, minByDuration) : minByDuration;
  const maxShots = isTenSecondVideo ? TEN_SECOND_STORYBOARD_MAX_SHOTS : Math.max(minShots, Math.ceil(duration / 2));
  return {
    duration,
    isTenSecondVideo,
    minShots,
    maxShots,
    maxShotDuration: MAX_STORYBOARD_BOARD_SHOT_DURATION,
  };
}

function buildStoryboardShotPolicyLines(totalDuration: number, options: { includeFormatLine?: boolean } = {}) {
  const policy = resolveStoryboardShotPolicy(totalDuration);
  const lines = [
    `单个镜头时长不得超过 ${policy.maxShotDuration} 秒；任何超过 ${policy.maxShotDuration} 秒的连续动作必须拆成多个镜头卡片。`,
  ];
  if (policy.isTenSecondVideo) {
    lines.push(`10 秒视频的故事板必须规划 ${policy.minShots}-${policy.maxShots} 张镜头卡片，推荐 4 张；不得只生成 1-2 张镜头。`);
  } else {
    lines.push(`本段至少规划 ${policy.minShots} 张镜头卡片，镜头数量要能覆盖 ${policy.duration}s 的动作节奏。`);
  }
  if (options.includeFormatLine) {
    lines.push("每个镜头标题必须写明覆盖分镜和时长，格式示例：## 镜头 01 / S01-S02 / 3s。");
  }
  return lines;
}

function getShotScriptHeadings(shotScript: string) {
  return shotScript.split(/\n+/).filter((line) => /^#{2,3}\s*镜头\s*\d+/i.test(line.trim()));
}

function extractShotScriptHeadingDurations(shotScript: string) {
  return getShotScriptHeadings(shotScript)
    .map((line) => line.match(/(?:\/|\s)(\d+(?:\.\d+)?)\s*(?:s|秒)(?:\s|$|[）)】\]:：，,。；;])/i)?.[1])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function findShotScriptPolicyViolations(shotScript: string, totalDuration: number) {
  const policy = resolveStoryboardShotPolicy(totalDuration);
  const headings = getShotScriptHeadings(shotScript);
  const durations = extractShotScriptHeadingDurations(shotScript);
  const violations: string[] = [];
  if (headings.length < policy.minShots) {
    violations.push(`镜头数量 ${headings.length} 少于最低要求 ${policy.minShots}`);
  }
  if (policy.isTenSecondVideo && headings.length > policy.maxShots) {
    violations.push(`10 秒故事板镜头数量 ${headings.length} 超过上限 ${policy.maxShots}`);
  }
  const tooLongDuration = durations.find((duration) => duration > policy.maxShotDuration);
  if (tooLongDuration) {
    violations.push(`存在 ${tooLongDuration}s 镜头，超过单镜头 ${policy.maxShotDuration}s 上限`);
  }
  return violations;
}

function formatStoryboardRows(storyboards: StoryboardBoardInput[], assetRefs: Array<EffectiveAssetReference & { storyboardId: number }>) {
  const refsByStoryboardId = new Map<number, Array<EffectiveAssetReference & { storyboardId: number }>>();
  assetRefs.forEach((ref) => {
    if (!refsByStoryboardId.has(ref.storyboardId)) refsByStoryboardId.set(ref.storyboardId, []);
    refsByStoryboardId.get(ref.storyboardId)!.push(ref);
  });

  return storyboards
    .map((item, index) => {
      const id = Number(item.id);
      const assets = Number.isInteger(id) ? refsByStoryboardId.get(id) || [] : [];
      const assetText = assets
        .map((asset) => {
          const desc = normalizeText(asset.describe);
          return `${asset.name}${asset.type ? `(${asset.type})` : ""}${desc ? `：${truncateText(desc, 120)}` : ""}`;
        })
        .join("；");
      return [
        `${storyboardLabel(item, index)} | 时长 ${normalizeStoryboardDuration(item.duration)}s | 轨道 ${normalizeText(item.track) || "默认"}`,
        `画面/动作：${normalizeText(item.videoDesc) || "未填写"}`,
        `分镜提示词：${truncateText(normalizeText(item.prompt), 420) || "未填写"}`,
        `关联资产：${assetText || "无"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatStoryboardPlanRows(storyboards: StoryboardBoardInput[]) {
  return storyboards
    .map((item, index) => {
      const label = storyboardLabel(item, index);
      return [
        `${label} | id=${item.id} | 时长 ${normalizeStoryboardDuration(item.duration)}s | 轨道 ${normalizeText(item.track) || "默认"}`,
        `画面/动作：${truncateText(normalizeText(item.videoDesc), 220) || "未填写"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:markdown|md|text)?/i, "").replace(/```$/i, "").trim();
}

function extractJsonArray(text: string) {
  const normalized = stripCodeFence(text);
  const match = normalized.match(/\[[\s\S]*]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function splitLongSegment(storyboards: StoryboardBoardInput[], targetDuration: number, reason: string): StoryboardBoardSegmentPlan[] {
  const result: StoryboardBoardSegmentPlan[] = [];
  for (let i = 0; i < storyboards.length; i += MAX_STORYBOARDS_PER_BOARD) {
    const chunk = storyboards.slice(i, i + MAX_STORYBOARDS_PER_BOARD);
    result.push({ storyboards: chunk, targetDuration, reason });
  }
  return result;
}

function buildFallbackSegments(storyboards: StoryboardBoardInput[], context: StoryboardBoardContext, reason = "自动兜底：按目标时长和最多 8 个镜头分段") {
  const targetDuration = normalizeTargetDuration(storyboards, context.targetDuration);
  const segments: StoryboardBoardSegmentPlan[] = [];
  let current: StoryboardBoardInput[] = [];
  let currentDuration = 0;

  for (const item of storyboards) {
    const duration = normalizeStoryboardDuration(item.duration);
    const shouldClose =
      current.length > 0 &&
      (current.length >= MAX_STORYBOARDS_PER_BOARD || (currentDuration + duration > targetDuration * 1.25 && currentDuration >= Math.max(1, targetDuration * 0.6)));
    if (shouldClose) {
      segments.push({ storyboards: current, targetDuration, reason });
      current = [];
      currentDuration = 0;
    }
    current.push(item);
    currentDuration += duration;
  }
  if (current.length) segments.push({ storyboards: current, targetDuration, reason });
  return segments.length ? segments : [{ storyboards, targetDuration, reason }];
}

function normalizeAgentSegments(rawSegments: any[], storyboards: StoryboardBoardInput[], context: StoryboardBoardContext) {
  const indexById = new Map(storyboards.map((item, index) => [Number(item.id), index]));
  const targetDuration = normalizeTargetDuration(storyboards, context.targetDuration);
  const result: StoryboardBoardSegmentPlan[] = [];
  let cursor = 0;

  for (const segment of rawSegments) {
    const rawIds = Array.isArray(segment?.storyboardIds) ? segment.storyboardIds : [];
    const indexes = rawIds
      .map((id: unknown) => indexById.get(Number(id)))
      .filter((index: unknown): index is number => Number.isInteger(index))
      .sort((a: number, b: number) => a - b);
    if (!indexes.length) continue;

    const end = Math.max(...indexes);
    if (end < cursor) continue;
    const start = cursor;
    const slice = storyboards.slice(start, end + 1);
    cursor = end + 1;
    const segmentDuration = Number(segment?.targetDuration);
    result.push(
      ...splitLongSegment(
        slice,
        Number.isFinite(segmentDuration) && segmentDuration > 0 ? Number(segmentDuration.toFixed(3)) : targetDuration,
        normalizeText(segment?.reason) || "Agent 自动分割",
      ),
    );
  }

  if (cursor < storyboards.length) {
    result.push(...splitLongSegment(storyboards.slice(cursor), targetDuration, "Agent 分割计划未覆盖的尾段，自动补齐"));
  }
  return result.length ? result : buildFallbackSegments(storyboards, context, "Agent 分割计划不可用，按时长兜底分割");
}

export async function planStoryboardBoardSegments(storyboards: StoryboardBoardInput[], context: StoryboardBoardContext): Promise<StoryboardBoardSegmentPlan[]> {
  if (storyboards.length <= MAX_STORYBOARDS_PER_BOARD) {
    return [
      {
        storyboards,
        targetDuration: normalizeTargetDuration(storyboards, context.targetDuration),
        reason: "镜头数量适合单页故事板",
      },
    ];
  }

  const targetDuration = normalizeTargetDuration(storyboards, context.targetDuration);
  try {
    const { text } = await u.Ai.Text("universalAi").invoke({
      system: [
        "你是影视导演和剪辑规划师，负责为 Toonflow 的故事板辅助单图模式决定分段。",
        "你只输出 JSON 数组，不输出 Markdown、解释或额外文本。",
        "故事板不是分镜图拼接。每个分段后续会生成一张分镜头脚本页，并生成一段单图视频。",
      ].join("\n"),
      prompt: [
        `项目名称：${context.projectName || "未命名项目"}`,
        `项目类型：${context.projectType || "未指定"}`,
        `导演手册：${context.directorManual || "未指定"}`,
        `目标单段视频时长：${targetDuration}s`,
        `每张故事板页最多 ${MAX_STORYBOARDS_PER_BOARD} 个源分镜。`,
        "",
        "剧本摘要：",
        truncateText(normalizeText(context.scriptContent), 2400) || "未提供",
        "",
        "候选分镜：",
        formatStoryboardPlanRows(storyboards),
        "",
        "请根据剧情节拍、动作连续性、台词完整性、场景转换、目标单段视频时长来自动分段。",
        "要求：",
        "- 分段必须覆盖所有输入分镜，不能遗漏，不能重复。",
        "- 每段必须是连续分镜，不能跳跃。",
        `- 每段最多 ${MAX_STORYBOARDS_PER_BOARD} 个源分镜。`,
        "- 尽量让每段是一个完整动作/情绪/台词小节，而不是机械等量切分。",
        "- targetDuration 表示该故事板页对应视频的建议时长，通常使用目标单段视频时长。",
        "",
        "只输出 JSON 数组，格式如下：",
        '[{"storyboardIds":[101,102,103],"targetDuration":6,"reason":"同一场景内的完整动作小节"}]',
      ].join("\n"),
    });
    const parsed = extractJsonArray(String(text || ""));
    if (!parsed) return buildFallbackSegments(storyboards, context, "Agent 未返回有效 JSON，按时长兜底分割");
    return normalizeAgentSegments(parsed, storyboards, context);
  } catch (e) {
    console.warn("[storyboardBoard.plan] Agent 自动分割失败，使用兜底分割:", u.error(e).message);
    return buildFallbackSegments(storyboards, context, "Agent 调用失败，按时长兜底分割");
  }
}

export function computeStoryboardBoardSourceHash(storyboards: StoryboardBoardInput[], context: Partial<StoryboardBoardContext> = {}) {
  const payload = {
    mode: "scriptShotSheet:v5-portraitShotDurationPolicy",
    projectId: context.projectId,
    scriptId: context.scriptId,
    scriptContent: truncateText(normalizeText(context.scriptContent), MAX_SCRIPT_CONTENT_LENGTH),
    projectType: context.projectType || "",
    artStyle: context.artStyle || "",
    directorManual: context.directorManual || "",
    imageModel: context.imageModel || "",
    targetDuration: normalizeTargetDuration(storyboards, context.targetDuration),
    ratio: STORYBOARD_BOARD_FIXED_IMAGE_RATIO,
    itemsPerBoard: context.itemsPerBoard || storyboards.length,
    storyboards: storyboards.map((item, index) => ({
      id: item.id,
      label: storyboardLabel(item, index),
      index: item.index,
      duration: item.duration,
      prompt: normalizeText(item.prompt),
      videoDesc: normalizeText(item.videoDesc),
      track: normalizeText(item.track),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function buildStoryboardShotScript(storyboards: StoryboardBoardInput[], context: StoryboardBoardContext) {
  const assetRefs = await resolveEffectiveStoryboardAssetReferences(
    storyboards.map((item) => Number(item.id)).filter((id) => Number.isInteger(id)),
  );
  const totalDuration = normalizeTargetDuration(storyboards, context.targetDuration);
  const storyboardRows = formatStoryboardRows(storyboards, assetRefs);
  let lastShotScript = "";
  let previousViolations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await u.Ai.Text("universalAi").invoke({
      system: [
        "你是影视导演和分镜师，负责把 Toonflow 的剧本与分镜面板转换为可执行的分镜头脚本。",
        "必须先理解剧情、角色、台词、动作和目标视频时长，再规划镜头。",
        "输出只保留分镜头脚本，不要输出解释、寒暄或生成图片说明。",
        "分镜头脚本将用于生成一张故事板页，故事板页不是已有分镜图拼接。",
      ].join("\n"),
      prompt: [
        `项目名称：${context.projectName || "未命名项目"}`,
        `项目类型：${context.projectType || "未指定"}`,
        `导演手册：${context.directorManual || "未指定"}`,
        `画风：${context.artStyle || "未指定"}`,
        `目标视频总时长：${totalDuration}s`,
        previousViolations.length ? `上一次输出不合规，必须修正：${previousViolations.join("；")}` : "",
        "",
        "剧本内容：",
        truncateText(normalizeText(context.scriptContent), MAX_SCRIPT_CONTENT_LENGTH) || "未提供",
        "",
        "分镜面板文本：",
        storyboardRows,
        "",
        "请按以下 Markdown 格式输出：",
        "# 分镜头脚本",
        `总时长：${totalDuration}s`,
        "## 镜头 01 / Sxx / 3s",
        "- 画面内容：",
        "- 景别：",
        "- 运镜：",
        "- 构图：",
        "- 角色调度：",
        "- 台词/配音：",
        "- 声音/情绪：",
        "- 故事板画面：",
        "",
        "约束：",
        ...buildStoryboardShotPolicyLines(totalDuration, { includeFormatLine: true }).map((line) => `- ${line}`),
        "- 镜头数量应与输入分镜范围匹配，必要时可把一个长分镜拆成多个镜头，也可把相邻极短分镜合并为一个镜头，但必须说明覆盖的 Sxx。",
        "- 总时长必须贴近目标视频总时长，单个镜头时长加总必须等于目标总时长。",
        "- 台词必须输出中文，除非原文明确是其他语言。",
        "- 不要假设已有分镜图可用；只根据剧本、分镜文本和资产描述规划故事板。",
      ].filter(Boolean).join("\n"),
    });

    const shotScript = stripCodeFence(String(text || "").trim());
    if (!shotScript) throw new Error("分镜头脚本生成失败：模型返回空内容");
    lastShotScript = truncateText(shotScript, MAX_SHOT_SCRIPT_LENGTH);
    previousViolations = findShotScriptPolicyViolations(lastShotScript, totalDuration);
    if (!previousViolations.length) return lastShotScript;
  }

  console.warn("[storyboardBoard.shotScript] 分镜头脚本未完全满足时长策略:", previousViolations.join("；"));
  return lastShotScript;
}

export function buildStoryboardBoardImagePrompt(shotScript: string, context: StoryboardBoardContext) {
  const aspectRatio = resolveAspectRatio();
  const targetDuration = normalizeTargetDuration([], context.targetDuration);
  const basePrompt = [
    "生成一张单页“分镜头脚本 / Storyboard Shot Sheet”图片，不要拼接任何已有分镜图。",
    `画幅比例：${aspectRatio} 竖版。整张图必须是竖向故事板工作页，禁止横版、宽屏、16:9、横向海报或左右横铺版式。`,
    "版式类似导演故事板工作页：清晰标题区 + 多个镜头卡片/竖向分层行。",
    `项目画风ID：${context.artStyle || "未指定"}。画风优先级最高，高于故事板版式和参考图偶发风格。`,
    ...buildStoryboardBoardFrameStyleLines(context.artStyle),
    "镜头拆分硬约束：",
    ...buildStoryboardShotPolicyLines(targetDuration).map((line) => `- ${line}`),
    "- 如果分镜头脚本草稿中存在单镜头超过 5 秒，画面中必须拆成多个镜头卡片表现。",
    "每个镜头卡片必须包含：符合项目画风的小画面框、SHOT、DURATION、SHOT SIZE、CAMERA MOVE、COMPOSITION、ACTION、CHINESE VOICE NOTE。",
    "画面应像影视导演用于拍摄沟通的故事板页，而不是照片拼贴、九宫格截图、宣传海报或单帧剧照。",
    "故事板页上的字段标签和画面动作说明优先使用简短英文，便于 Grok 视频模型理解。",
    "中文台词只允许作为制作备注出现，必须标注为 Chinese Mandarin VO / dialogue note；不要把台词画成画面内字幕。",
    "小画面框内禁止出现任何字幕、caption、burned-in text、对话气泡、Logo、水印或二维码。",
    "每个小画面框要表达镜头调度、人物位置、运动方向和情绪重点；不要把所有镜头画成同一个构图。",
    "如果提供了参考图，角色/场景/道具资产图优先用于锁定项目实际画风、角色外观、服装、场景和道具质感；不要把参考图直接拼贴到故事板页中。",
    "如果某张分镜参考图与项目画风不一致，只提取构图、动作和身份信息，不继承其错误画风。",
    "",
    "分镜头脚本：",
    truncateText(shotScript, 2600),
  ].join("\n");

  return truncateText(buildStoryboardImagePrompt(basePrompt, context.artStyle), MAX_IMAGE_PROMPT_LENGTH);
}

function pushUniquePath(paths: string[], value?: string | null) {
  const path = normalizeText(value);
  if (!path || paths.includes(path)) return;
  paths.push(path);
}

async function buildStoryboardBoardImageReferences(storyboards: StoryboardBoardInput[]) {
  const storyboardImagePaths: string[] = [];
  storyboards.forEach((item) => pushUniquePath(storyboardImagePaths, item.filePath));

  const assetRefs = await resolveEffectiveStoryboardAssetReferences(
    storyboards.map((item) => Number(item.id)).filter((id) => Number.isInteger(id)),
  );
  const assetImagePaths: string[] = [];
  assetRefs.forEach((item) => pushUniquePath(assetImagePaths, item.filePath));

  const assetReferenceCount = Math.min(5, assetImagePaths.length, MAX_STORYBOARD_BOARD_REFERENCES);
  const selectedPaths = [
    ...assetImagePaths.slice(0, assetReferenceCount),
    ...storyboardImagePaths.slice(0, Math.max(0, MAX_STORYBOARD_BOARD_REFERENCES - assetReferenceCount)),
  ].slice(0, MAX_STORYBOARD_BOARD_REFERENCES);
  if (!selectedPaths.length) return [];

  const budget = getReferenceImageBudget(selectedPaths.length);
  const references = await Promise.all(
    selectedPaths.map(async (filePath) => {
      try {
        const url = await u.oss.getFileUrl(filePath);
        const base64 = await urlToCompressedBase64(url, budget);
        return { type: "image" as const, base64 };
      } catch (e) {
        console.warn("[storyboardBoard.imageReference] 参考图读取失败:", filePath, u.error(e).message);
        return null;
      }
    }),
  );
  return references.filter((item): item is { type: "image"; base64: string } => item != null);
}

export async function generateStoryboardBoardImageFromScript(
  storyboards: StoryboardBoardInput[],
  context: StoryboardBoardContext,
  options: { shotScript?: string | null } = {},
): Promise<StoryboardBoardImageResult> {
  if (!context.imageModel) throw new Error("项目未配置图片生成模型");
  const providedShotScript = String(options.shotScript || "").trim();
  const targetDuration = normalizeTargetDuration(storyboards, context.targetDuration);
  const shouldReuseShotScript = providedShotScript && !findShotScriptPolicyViolations(providedShotScript, targetDuration).length;
  const shotScript = shouldReuseShotScript ? providedShotScript : await buildStoryboardShotScript(storyboards, context);
  const imagePrompt = buildStoryboardBoardImagePrompt(shotScript, context);
  const aspectRatio = resolveAspectRatio();
  const uuid = u.uuid();
  const filePath = `/${context.projectId}/storyboardBoard/${uuid}.jpg`;
  const thumbPath = `/${context.projectId}/storyboardBoard/thumb/${uuid}.webp`;
  const sourceHash = computeStoryboardBoardSourceHash(storyboards, context);
  const referenceList = await buildStoryboardBoardImageReferences(storyboards);

  const image = await u.Ai.Image(context.imageModel as `${string}:${string}`).run(
    {
      prompt: imagePrompt,
      referenceList,
      size: (context.imageQuality || "2K") as "1K" | "2K" | "4K",
      aspectRatio,
    },
    {
      taskClass: "生成故事板图片",
      describe: `根据分镜头脚本生成故事板页，画风：${context.artStyle || "未指定"}`,
      relatedObjects: JSON.stringify({
        projectId: context.projectId,
        scriptId: context.scriptId,
        storyboardIds: storyboards.map((item) => item.id),
        targetDuration: normalizeTargetDuration(storyboards, context.targetDuration),
        ratio: aspectRatio,
        sourceType: "scriptShotSheet",
        referenceCount: referenceList.length,
      }),
      projectId: context.projectId,
    },
  );
  await image.save(filePath);

  const imageBuffer = await u.oss.getFile(filePath);
  const thumbBuffer = await sharp(imageBuffer).resize(720, 720, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  await u.oss.writeFile(thumbPath, thumbBuffer);

  return {
    filePath,
    thumbPath,
    shotScript,
    imagePrompt,
    imageModel: context.imageModel,
    targetDuration: normalizeTargetDuration(storyboards, context.targetDuration),
    sourceHash,
  };
}

export async function buildStoryboardBoardVideoPrompt(
  storyboards: StoryboardBoardInput[],
  model: string,
  targetDuration: number,
  shotScript?: string | null,
) {
  const rows = storyboards
    .map((item, index) => {
      const label = storyboardLabel(item, index);
      return `${label} ${normalizeStoryboardDuration(item.duration)}s：${normalizeText(item.videoDesc) || normalizeText(item.prompt) || "按故事板页内容执行"}`;
    })
    .join("\n");
  const isGrok = model.toLowerCase().includes("grok");
  const grokDurations = getGrokVideoSupportedDurations(model);
  const durationNote = isGrok ? `Grok 视频只支持 ${grokDurations.join(" 秒、")} 秒，请按最终提交时长压缩节奏。` : "按最终提交时长重算镜头节奏。";
  if (isGrok) {
    const prompt = [
      "Use the single storyboard sheet image as the only visual reference for generating a continuous video.",
      "The image is a director shot sheet, not a static collage. Follow the shot numbers, action order, camera movement, staging, emotion, and dialogue timing.",
      `Target duration: ${targetDuration}s. Grok video supports ${grokDurations.join("s, ")}s only, so compress the pacing to the submitted duration.`,
      "Timing rules:",
      ...buildStoryboardShotPolicyLines(targetDuration).map((line) => `- ${line}`),
      "Audio rule: all spoken dialogue, voiceover, and character dubbing must be in Chinese Mandarin.",
      "Visual text rule: no subtitles, no captions, no burned-in text, no speech bubbles, no title cards, and no readable text in the video frame.",
      "If the storyboard image contains text notes, treat them only as production notes, not as on-screen text to render.",
      "Keep the established project art style, character identity, wardrobe, scene relationship, and camera continuity.",
      "",
      shotScript?.trim()
        ? `Shot script. Dialogue content is Chinese Mandarin audio only, never on-screen subtitles:\n${shotScript.trim()}`
        : `Storyboard range. Dialogue content is Chinese Mandarin audio only, never on-screen subtitles:\n${rows}`,
    ].join("\n");
    return truncateTextByUtf8Bytes(prompt, MAX_VIDEO_PROMPT_BYTES);
  }

  const prompt = [
    "参考输入的单张故事板页生成连续视频。",
    "这张图是导演分镜头脚本页，不是静态拼贴图；请按镜头编号顺序推进剧情、动作、调度和台词。",
    `目标时长：${targetDuration}s。${durationNote}`,
    "镜头节奏硬约束：",
    ...buildStoryboardShotPolicyLines(targetDuration).map((line) => `- ${line}`),
    "配音、旁白和角色台词必须使用中文普通话；没有台词的镜头不要生成口型。",
    "画面中禁止出现字幕、caption、硬字幕、对话气泡、标题卡或任何可读文字。",
    "故事板图上的文字只作为制作备注理解，不要渲染成视频画面文字。",
    "保持项目既定画风、角色身份、服装、场景关系和镜头连续性。",
    "",
    shotScript?.trim() ? `分镜头脚本：\n${shotScript.trim()}` : `分镜范围：\n${rows}`,
  ].join("\n");

  return truncateTextByUtf8Bytes(prompt, MAX_VIDEO_PROMPT_BYTES);
}
