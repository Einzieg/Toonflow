import crypto from "crypto";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
import { getReferenceImageBudget } from "@/utils/vm";
import { REMOTE_VIDEO_URL_TTL_MS, getPublicOssFileUrl, getRenderableVideoSrc, normalizeVideoState } from "@/utils/videoSource";
import { resolveVideoGenerationDuration, shouldUsePublicImageReferenceForVideoModel } from "@/utils/storyboardTrack";
import { minShotCount, resolveMaxShotDurationSeconds, type ShotPolicyContext } from "@/utils/shotPolicy";
import { mediaPromptSafetyInstruction } from "@/utils/promptSafety";
import {
  DEFAULT_STORYBOARD_VIDEO_FORBIDDEN_ADDITIONS,
  createStoryboardVideoReference,
  fitStoryboardVideoReferenceDuration,
  renderStoryboardVideoReferencePrompt,
  validateStoryboardVideoReferenceResult,
  type ShotFrameSource,
  type StoryboardVideoReferenceResult,
} from "@/utils/storyboardVideoReference";
import {
  cleanupStoryboardFirstByProjectScript,
  cleanupStoryboardFirstImagesByIds,
  cleanupStoryboardFirstVideosByImageIds,
} from "@/utils/storyboardFirstCleanup";

export const STORYBOARD_FIRST_ASPECT_RATIO = "9:16" as const;
const SCRIPT_PROMPT_VERSION = "storyboard-first-script:v1";
const IMAGE_PROMPT_VERSION = "storyboard-first-image:v1";
const VIDEO_PROMPT_VERSION = "storyboard-first-video:v1";
const MAX_SCRIPT_CONTENT_LENGTH = 7000;
const MAX_ASSET_SNAPSHOT_LENGTH = 2600;
const MAX_SHOT_SCRIPT_LENGTH = 7000;
const MAX_IMAGE_PROMPT_LENGTH = 3800;
const MAX_VIDEO_PROMPT_BYTES = 3600;
const MAX_REFERENCE_IMAGES = 7;

type StoryboardFirstState = "未生成" | "生成中" | "已完成" | "生成失败" | "已取消";

interface ProjectContext {
  id: number;
  name?: string | null;
  projectType?: string | null;
  type?: string | null;
  artStyle?: string | null;
  directorManual?: string | null;
  imageModel?: string | null;
  imageQuality?: "1K" | "2K" | "4K" | null;
  videoModel?: string | null;
}

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
  const headBytes = Math.min(2200, Math.max(0, maxBytes - markerBytes));
  const tailBytes = Math.max(0, maxBytes - headBytes - markerBytes);
  return `${takeFirstUtf8Bytes(value, headBytes).trimEnd()}${marker}${takeLastUtf8Bytes(value, tailBytes).trimStart()}`;
}

function hashPayload(payload: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:markdown|md|text)?/i, "").replace(/```$/i, "").trim();
}

function resolveTargetDuration(value?: number | null) {
  const duration = Number(value);
  if (Number.isFinite(duration) && duration > 0) return Number(duration.toFixed(3));
  return 10;
}

function recommendedSegmentCount(targetDuration: number) {
  if (targetDuration <= 6) return 3;
  if (targetDuration <= 10) return 4;
  if (targetDuration <= 15) return 5;
  return Math.max(3, Math.ceil(targetDuration / 4));
}

function buildStoryboardFirstShotPolicyContext(project?: Pick<ProjectContext, "videoModel"> | null, modelDetail?: any): ShotPolicyContext {
  return {
    videoModel: project?.videoModel || modelDetail?.modelName || "",
    videoModelName: modelDetail?.name || modelDetail?.modelName || null,
  };
}

function getShotScriptHeadings(shotScript: string) {
  return shotScript.split(/\n+/).filter((line) => /^#{2,3}\s*镜头\s*\d+/i.test(line.trim()));
}

function extractShotDurations(shotScript: string) {
  return getShotScriptHeadings(shotScript)
    .map((line) => line.match(/(?:\/|\s)(\d+(?:\.\d+)?)\s*(?:s|秒)(?:\s|$|[）)】\]:：，,。；;])/i)?.[1])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function findShotScriptPolicyViolations(shotScript: string, targetDuration: number, policyContext?: ShotPolicyContext | null) {
  const headings = getShotScriptHeadings(shotScript);
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);
  const minShots = minShotCount(targetDuration, policyContext);
  const violations: string[] = [];
  if (headings.length < minShots) violations.push(`镜头数量 ${headings.length} 少于最低要求 ${minShots}`);
  if (Math.abs(targetDuration - 10) < 0.01 && headings.length < 3) violations.push("10 秒故事板至少需要 3 个镜头");
  const tooLong = extractShotDurations(shotScript).find((duration) => duration > maxShotDuration);
  if (tooLong) violations.push(`存在 ${tooLong}s 镜头，超过单镜头 ${maxShotDuration}s 上限`);
  return violations;
}

function buildShotPolicyLines(targetDuration: number, policyContext?: ShotPolicyContext | null) {
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);
  const minShots = minShotCount(targetDuration, policyContext);
  const recommended = recommendedSegmentCount(targetDuration);
  const lines = [
    `单个镜头时长不得超过 ${maxShotDuration} 秒；超过 ${maxShotDuration} 秒的连续动作必须拆成多个镜头。`,
    `本次目标总时长 ${targetDuration}s，最低 ${minShots} 个镜头，建议 ${recommended} 个镜头。`,
  ];
  if (maxShotDuration > 5) {
    lines.push(`当前视频模型允许单镜校验上限放宽到 ${maxShotDuration}s，但仍需在动作、情绪、台词或场景转折处主动拆镜，不能为了贴近上限强行合并。`);
  }
  if (Math.abs(targetDuration - 6) < 0.01) lines.push("6 秒视频建议 2-3 个镜头。");
  if (Math.abs(targetDuration - 10) < 0.01) lines.push("10 秒视频必须 3-5 个镜头，推荐 4 个镜头。");
  if (Math.abs(targetDuration - 15) < 0.01) lines.push("15 秒视频建议 4-6 个镜头。");
  return lines;
}

async function getProjectContext(projectId: number): Promise<ProjectContext> {
  const project = await u
    .db("o_project")
    .where("id", projectId)
    .select("id", "name", "projectType", "type", "artStyle", "directorManual", "imageModel", "imageQuality", "videoModel")
    .first();
  if (!project) throw new Error("项目不存在");
  return project as ProjectContext;
}

async function getScript(projectId: number, scriptId: number) {
  const script = await u.db("o_script").where({ id: scriptId, projectId }).select("id", "name", "content", "projectId").first();
  if (!script) throw new Error("剧集不存在或不属于当前项目");
  return script;
}

async function getAssetsSnapshot(projectId: number, scriptId: number) {
  const assets = await u
    .db("o_assets")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .where("o_assets.projectId", projectId)
    .where((builder: any) => builder.where("o_assets.scriptId", scriptId).orWhereNull("o_assets.scriptId"))
    .select(
      "o_assets.id",
      "o_assets.name",
      "o_assets.type",
      "o_assets.describe",
      "o_assets.prompt",
      "o_assets.remark",
      "o_assets.volcengineAssetUri",
      "o_image.filePath as filePath",
    )
    .orderBy("o_assets.type", "asc")
    .orderBy("o_assets.id", "asc");

  const rows = assets.map((asset: any) => ({
    id: Number(asset.id),
    name: normalizeText(asset.name),
    type: normalizeText(asset.type),
    describe: truncateText(normalizeText(asset.describe || asset.remark || asset.prompt), 260),
    filePath: normalizeText(asset.filePath),
    volcengineAssetUri: normalizeText(asset.volcengineAssetUri),
  }));
  return {
    rows,
    text: truncateText(
      rows
        .map((asset) => `${asset.id} | ${asset.type || "asset"} | ${asset.name || "未命名"}：${asset.describe || "无描述"}`)
        .join("\n"),
      MAX_ASSET_SNAPSHOT_LENGTH,
    ),
    hash: hashPayload(rows),
  };
}

function computeInputHash(input: {
  scriptContent: string;
  targetDuration: number;
  project: ProjectContext;
  assetHash: string;
}) {
  return hashPayload({
    promptVersion: SCRIPT_PROMPT_VERSION,
    scriptContent: truncateText(normalizeText(input.scriptContent), MAX_SCRIPT_CONTENT_LENGTH),
    targetDuration: input.targetDuration,
    projectName: input.project.name || "",
    projectType: input.project.projectType || input.project.type || "",
    artStyle: input.project.artStyle || "",
    directorManual: input.project.directorManual || "",
    imageModel: input.project.imageModel || "",
    assetHash: input.assetHash,
  });
}

function computeShotScriptHash(shotScript: string) {
  return hashPayload({
    promptVersion: SCRIPT_PROMPT_VERSION,
    shotScript: normalizeText(shotScript),
  });
}

function computeImageSourceHash(input: {
  firstScript: any;
  project: ProjectContext;
  imageModel: string;
  imageQuality: string;
  assetHash: string;
}) {
  return hashPayload({
    promptVersion: IMAGE_PROMPT_VERSION,
    shotScriptHash: input.firstScript.shotScriptHash,
    scriptRevision: input.firstScript.scriptRevision,
    artStyle: input.project.artStyle || "",
    directorManual: input.project.directorManual || "",
    imageModel: input.imageModel,
    imageQuality: input.imageQuality,
    assetHash: input.assetHash,
    aspectRatio: STORYBOARD_FIRST_ASPECT_RATIO,
  });
}

function buildImagePrompt(shotScript: string, project: ProjectContext, targetDuration: number, assetSnapshotText: string) {
  const basePrompt = [
    "生成一张单页“Storyboard First / story-driven shot sheet”竖版故事板图片。",
    `画幅比例：${STORYBOARD_FIRST_ASPECT_RATIO}。整张图必须为竖版，禁止横版、宽屏、左右横铺版式。`,
    "这不是把分镜图拼接成长图，也不是宣传海报；必须根据下方分镜脚本绘制多格镜头卡片。",
    "版式：清晰标题区 + 纵向排列的多个镜头卡片，每个卡片含小画面框、SHOT、DURATION、SHOT SIZE、CAMERA MOVE、COMPOSITION、ACTION、CHINESE VOICE NOTE。",
    `项目画风ID：${project.artStyle || "未指定"}。画风优先级最高，高于故事板版式和参考图偶发风格。`,
    "每个小画面框必须符合项目当前画风，角色、服装、场景、道具、光影和材质不能漂移。",
    "参考图只用于锁定角色、服装、场景和道具，不要把参考图直接拼贴进故事板页。",
    "镜头拆分硬约束：",
    ...buildShotPolicyLines(targetDuration, buildStoryboardFirstShotPolicyContext(project)).map((line) => `- ${line}`),
    "故事板页上的字段标签和画面动作说明优先使用简短英文，便于 Grok 视频模型理解。",
    "中文台词只允许作为制作备注出现，必须标注为 Chinese Mandarin VO / dialogue note；不要把台词画成画面内字幕。",
    "小画面框内禁止出现任何字幕、caption、burned-in text、对话气泡、Logo、水印或二维码。",
    mediaPromptSafetyInstruction(),
    "",
    "项目信息：",
    `项目名：${project.name || "未命名"}`,
    `项目类型：${project.projectType || project.type || "未指定"}`,
    `导演手册：${truncateText(normalizeText(project.directorManual), 700) || "未指定"}`,
    "",
    "资产摘要：",
    assetSnapshotText || "无资产摘要",
    "",
    "分镜头脚本：",
    truncateText(shotScript, 2600),
  ].join("\n");

  return truncateText(buildStoryboardImagePrompt(basePrompt, project.artStyle), MAX_IMAGE_PROMPT_LENGTH);
}

function buildScriptPrompt(input: {
  project: ProjectContext;
  scriptName?: string | null;
  scriptContent: string;
  targetDuration: number;
  assetSnapshotText: string;
  previousViolations?: string[];
}) {
  return [
    `项目名称：${input.project.name || "未命名项目"}`,
    `剧集名称：${input.scriptName || "未命名剧集"}`,
    `项目类型：${input.project.projectType || input.project.type || "未指定"}`,
    `画风：${input.project.artStyle || "未指定"}`,
    `导演手册：${input.project.directorManual || "未指定"}`,
    `目标视频总时长：${input.targetDuration}s`,
    input.previousViolations?.length ? `上一次输出不合规，必须修正：${input.previousViolations.join("；")}` : "",
    "",
    "资产摘要：",
    input.assetSnapshotText || "无资产摘要",
    "",
    "剧本内容：",
    truncateText(normalizeText(input.scriptContent), MAX_SCRIPT_CONTENT_LENGTH) || "未提供",
    "",
    "请输出 Markdown，格式必须如下：",
    "# 故事板先行分镜脚本",
    `总时长：${input.targetDuration}s`,
    "",
    "## 镜头 01 / 3s",
    "- 画面内容：",
    "- 景别：",
    "- 运镜：",
    "- 构图：",
    "- 角色调度：",
    "- 台词/配音：",
    "- 声音/情绪：",
    "- 故事板画面：",
    "",
    "硬性约束：",
    ...buildShotPolicyLines(input.targetDuration, buildStoryboardFirstShotPolicyContext(input.project)).map((line) => `- ${line}`),
    "- 从剧本直接拆解镜头，不引用已有分镜图，不假设已有分镜面板。",
    "- 镜头数量由剧情节奏自动判断，但必须覆盖完整动作和台词节奏。",
    "- 台词默认中文；没有台词写“无台词”。",
    `- ${mediaPromptSafetyInstruction().replace(/\n/g, " ")}`,
    "- 只输出分镜头脚本，不要输出解释、寒暄、JSON 或代码块。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function createShotScript(input: {
  project: ProjectContext;
  scriptName?: string | null;
  scriptContent: string;
  targetDuration: number;
  assetSnapshotText: string;
}) {
  let lastScript = "";
  let previousViolations: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await u.Ai.Text("universalAi").invoke({
      system: [
        "你是影视导演和分镜师，负责从剧本直接生成故事板先行工作流的分镜头脚本。",
        "你必须先理解剧情、角色、动作、台词、情绪和总时长，再规划镜头。",
        "故事板先行不依赖分镜面板；禁止提到已有分镜图或把分镜图拼接成故事板。",
        "输出只保留分镜头脚本。",
      ].join("\n"),
      prompt: buildScriptPrompt({
        ...input,
        previousViolations,
      }),
    });
    const shotScript = truncateText(stripCodeFence(String(text || "").trim()), MAX_SHOT_SCRIPT_LENGTH);
    if (!shotScript) throw new Error("分镜脚本生成失败：模型返回空内容");
    lastScript = shotScript;
    previousViolations = findShotScriptPolicyViolations(shotScript, input.targetDuration, buildStoryboardFirstShotPolicyContext(input.project));
    if (!previousViolations.length) return shotScript;
  }
  console.warn("[storyboardFirst.script] 分镜脚本未完全满足时长策略:", previousViolations.join("；"));
  return lastScript;
}

async function buildImageReferences(assets: Array<{ filePath?: string | null }>) {
  const paths = Array.from(new Set(assets.map((asset) => normalizeText(asset.filePath)).filter(Boolean))).slice(0, MAX_REFERENCE_IMAGES);
  if (!paths.length) return [];
  const budget = getReferenceImageBudget(paths.length);
  const references = await Promise.all(
    paths.map(async (filePath) => {
      try {
        const source = await u.oss.getFile(filePath);
        const metadata = await sharp(source).metadata();
        const minSide = Math.min(Number(metadata.width || 0), Number(metadata.height || 0));
        const normalizedBuffer =
          minSide > 0 && minSide <= 300
            ? await sharp(source)
                .rotate()
                .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: false })
                .jpeg({ quality: 88, mozjpeg: true })
                .toBuffer()
            : source;
        const compressed = await sharp(normalizedBuffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: normalizedBuffer.length > budget ? 76 : 84, mozjpeg: true })
          .toBuffer();
        return { type: "image" as const, base64: `data:image/jpeg;base64,${compressed.toString("base64")}` };
      } catch (e) {
        console.warn("[storyboardFirst.imageReference] 参考图读取失败:", filePath, u.error(e).message);
        return null;
      }
    }),
  );
  return references.filter((item): item is { type: "image"; base64: string } => item != null);
}

function parseShotScriptSections(shotScript: string, fallbackDuration: number) {
  const lines = String(shotScript || "").split(/\r?\n/);
  const sections: Array<{ shotNo: number; duration: number; text: string }> = [];
  let current: { shotNo: number; duration: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    sections.push({
      shotNo: current.shotNo,
      duration: current.duration,
      text: current.lines.join("\n").trim(),
    });
  };

  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s*镜头\s*(\d+)(?:.*?(\d+(?:\.\d+)?)\s*(?:s|秒))?/i);
    if (heading) {
      flush();
      current = {
        shotNo: Number(heading[1]),
        duration: Number(heading[2]) || 0,
        lines: [line],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();

  if (!sections.length) {
    return [
      {
        shotNo: 1,
        duration: fallbackDuration,
        text: shotScript,
      },
    ];
  }

  const missingDuration = sections.some((item) => !Number.isFinite(item.duration) || item.duration <= 0);
  if (missingDuration) {
    const average = fallbackDuration / sections.length;
    return sections.map((item, index) => ({
      ...item,
      duration: Number.isFinite(item.duration) && item.duration > 0
        ? item.duration
        : Number((index === sections.length - 1 ? fallbackDuration - average * (sections.length - 1) : average).toFixed(3)),
    }));
  }
  return sections;
}

function extractShotScriptLine(sectionText: string, label: string) {
  const match = sectionText.match(new RegExp(`-\\s*${label}：([^\\n]+)`));
  return normalizeText(match?.[1] || "");
}

function buildVisualOnlyFramePrompt(sectionText: string, project: ProjectContext) {
  return buildStoryboardImagePrompt(
    [
      "Generate one vertical visual-only cinematic key frame for this storyboard shot.",
      "No text, no subtitles, no captions, no title card, no labels, no UI, no speech bubbles, no watermark.",
      "Do not draw a storyboard page, panel border, shot label, duration label, or production note.",
      mediaPromptSafetyInstruction(),
      `Project art style ID: ${project.artStyle || "unspecified"}. Keep exactly this project style.`,
      `Director manual: ${truncateText(normalizeText(project.directorManual), 500) || "unspecified"}.`,
      "Use the shot script below only as visual direction:",
      truncateText(sectionText, 1200),
    ].join("\n"),
    project.artStyle,
  );
}

async function generateStoryboardFirstVideoReference(input: {
  imageRow: any;
  firstScript: any;
  modelDetail?: any;
  targetDuration?: number;
}): Promise<StoryboardVideoReferenceResult> {
  if (input.imageRow.videoReferencePath && input.imageRow.frameManifest) {
    const frameManifest = JSON.parse(input.imageRow.frameManifest || "[]");
    let cursor = 0;
    const shotTimeline = parseShotScriptSections(input.firstScript.shotScript || "", Number(input.firstScript.targetDuration || 10)).map((section) => {
      const start = Number(cursor.toFixed(3));
      const end = Number((cursor + section.duration).toFixed(3));
      cursor = end;
      return {
        shotNo: section.shotNo,
        start,
        end,
        duration: section.duration,
        visualObjective: extractShotScriptLine(section.text, "画面内容") || section.text,
        actionUnit: extractShotScriptLine(section.text, "角色调度") || extractShotScriptLine(section.text, "画面内容") || section.text,
        cameraMove: extractShotScriptLine(section.text, "运镜") || "按参考帧执行",
        shotSize: extractShotScriptLine(section.text, "景别") || "按参考帧执行",
        emotion: extractShotScriptLine(section.text, "声音/情绪") || "按参考帧执行",
        dialogue: extractShotScriptLine(section.text, "台词/配音") || "无台词",
      };
    });
    return fitStoryboardVideoReferenceDuration(
      {
        mode: input.imageRow.videoReferenceMode || "singleComposite",
        videoReferencePath: input.imageRow.videoReferencePath,
        referencePaths: [input.imageRow.videoReferencePath],
        frameManifest,
        shotTimeline,
        lockedNarrative: {
          allowedCharacters: [],
          allowedScenes: [],
          allowedProps: [],
          requiredBeats: shotTimeline.map((item) => item.visualObjective),
          forbiddenAdditions: DEFAULT_STORYBOARD_VIDEO_FORBIDDEN_ADDITIONS,
        },
      },
      Number(input.targetDuration || input.firstScript.targetDuration || 0),
    );
  }

  const project = await getProjectContext(Number(input.imageRow.projectId));
  const assets = JSON.parse(input.imageRow.referenceSnapshot || "[]");
  const referenceList = await buildImageReferences(assets);
  const sections = parseShotScriptSections(input.firstScript.shotScript || "", Number(input.firstScript.targetDuration || 10));
  const frames: ShotFrameSource[] = [];

  for (const section of sections) {
    const framePath = `/${input.imageRow.projectId}/storyboardFirst/videoReferenceFrames/${uuidv4()}.jpg`;
    const framePrompt = buildVisualOnlyFramePrompt(section.text, project);
    const frameImage = await u.Ai.Image(input.imageRow.imageModel as `${string}:${string}`).run(
      {
        prompt: framePrompt,
        referenceList,
        size: (input.imageRow.imageQuality || "2K") as "1K" | "2K" | "4K",
        aspectRatio: STORYBOARD_FIRST_ASPECT_RATIO,
      },
      {
        projectId: Number(input.imageRow.projectId),
        taskClass: "生成故事板先行视频参考帧",
        describe: "根据故事板先行分镜脚本生成无文字视频参考帧",
        relatedObjects: JSON.stringify({
          projectId: input.imageRow.projectId,
          scriptId: input.imageRow.scriptId,
          firstScriptId: input.imageRow.firstScriptId,
          firstImageId: input.imageRow.id,
          shotNo: section.shotNo,
          sourceType: "storyboardFirstVideoReference",
        }),
      },
    );
    await frameImage.save(framePath);
    frames.push({
      shotNo: section.shotNo,
      filePath: framePath,
      duration: section.duration,
      visualObjective: extractShotScriptLine(section.text, "画面内容") || section.text,
      actionUnit: extractShotScriptLine(section.text, "角色调度") || extractShotScriptLine(section.text, "画面内容") || section.text,
      cameraMove: extractShotScriptLine(section.text, "运镜") || "按参考帧执行",
      shotSize: extractShotScriptLine(section.text, "景别") || "按参考帧执行",
      emotion: extractShotScriptLine(section.text, "声音/情绪") || "按参考帧执行",
      dialogue: extractShotScriptLine(section.text, "台词/配音") || "无台词",
      scene: "",
      characters: [],
      props: [],
      owned: true,
    });
  }

  const result = fitStoryboardVideoReferenceDuration(
    await createStoryboardVideoReference({
      projectId: Number(input.imageRow.projectId),
      frames,
      modelDetail: input.modelDetail,
      requestedMode: "auto",
    }),
    Number(input.targetDuration || input.firstScript.targetDuration || 0),
  );
  await u.db("o_storyboardFirstImage").where("id", input.imageRow.id).update({
    videoReferencePath: result.videoReferencePath,
    videoReferenceMode: result.mode,
    frameManifest: JSON.stringify(result.frameManifest),
    updateTime: Date.now(),
  });
  return result;
}

async function saveImageThumbnail(filePath: string, thumbPath: string) {
  const imageBuffer = await u.oss.getFile(filePath);
  const thumbBuffer = await sharp(imageBuffer).resize(720, 720, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  await u.oss.writeFile(thumbPath, thumbBuffer);
}

function modeSupportsSingleImage(mode: unknown) {
  if (!Array.isArray(mode)) return false;
  return mode.some((item) => item === "singleImage" || (Array.isArray(item) && item.includes("singleImage")));
}

async function getVideoModelDetail(model: string) {
  const [vendorId, modelName] = String(model || "").split(/:(.+)/);
  if (!vendorId || !modelName) throw new Error("视频模型格式不正确");
  const models = await u.vendor.getModelList(vendorId);
  const detail = models.find((item: any) => item.modelName === modelName);
  if (!detail) throw new Error("视频模型不存在或供应商未启用");
  if (!modeSupportsSingleImage(detail.mode)) throw new Error("当前模型不支持单图生视频");
  return detail;
}

function durationMatchesMap(itemDurations: number[], duration: number) {
  if (!itemDurations.length) return true;
  const values = itemDurations.filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return true;
  return duration >= Math.min(...values) && duration <= Math.max(...values);
}

function getSupportedResolutions(detail: any, duration: number) {
  const resolutions = new Set<string>();
  if (Array.isArray(detail?.durationResolutionMap)) {
    detail.durationResolutionMap.forEach((item: any) => {
      const itemDurations = Array.isArray(item.duration) ? item.duration.map((value: any) => Number(value)) : [];
      if (durationMatchesMap(itemDurations, duration)) {
        (Array.isArray(item.resolution) ? item.resolution : []).forEach((resolution: any) => resolution && resolutions.add(String(resolution)));
      }
    });
  }
  return Array.from(resolutions);
}

function resolveVideoResolution(detail: any, duration: number, requested: string) {
  const supported = getSupportedResolutions(detail, duration);
  if (!supported.length) return requested;
  if (supported.includes(requested)) return requested;
  const sizeMatch = requested.match(/^(\d+)x(\d+)$/i);
  if (sizeMatch) {
    const reversed = `${sizeMatch[2]}x${sizeMatch[1]}`;
    if (supported.includes(reversed)) return reversed;
  }
  throw new Error(`当前模型不支持 ${requested} 分辨率，可用分辨率：${supported.join(", ")}`);
}

function shouldUsePublicImageReference(model: string) {
  return shouldUsePublicImageReferenceForVideoModel(model);
}

function isGrokModel(model: string) {
  return model.toLowerCase().includes("grok");
}

export function buildStoryboardFirstVideoPrompt(shotScript: string, model: string, targetDuration: number, policyContext?: ShotPolicyContext | null) {
  const resolvedPolicyContext = policyContext || { videoModel: model };
  if (isGrokModel(model)) {
    const prompt = [
      "Use the single vertical storyboard image as the only visual reference for generating a continuous video.",
      "The image is a director storyboard sheet with ordered shot cards. Follow the shot order, action flow, camera blocking, emotion, and continuity. Do not treat it as one still poster.",
      `Target total duration: ${targetDuration}s.`,
      "Grok supports @image references. Use only the current storyboard image; do not invent extra reference characters or assets.",
      "Timing rules:",
      ...buildShotPolicyLines(targetDuration, resolvedPolicyContext).map((line) => `- ${line}`),
      "Audio rule: all spoken dialogue, voiceover, and character dubbing must be in Chinese Mandarin.",
      "Visual text rule: no subtitles, no captions, no burned-in text, no speech bubbles, no title cards, and no readable text in the video frame.",
      mediaPromptSafetyInstruction(),
      "If the storyboard image contains text notes, treat them only as production notes, not as on-screen text to render.",
      "Keep the established project art style, character identity, wardrobe, scene relationship, and camera continuity.",
      "",
      "Shot script. Dialogue content is Chinese Mandarin audio only, never on-screen subtitles:",
      truncateText(shotScript, 3000),
    ].join("\n");
    return truncateTextByUtf8Bytes(prompt, MAX_VIDEO_PROMPT_BYTES);
  }

  const prompt = [
    "参考输入的单张竖版故事板图片生成连续视频。",
    "这张图是导演故事板页，包含按顺序排列的多个镜头卡片；请按镜头编号顺序推进剧情、动作、调度和台词，不要把它当成单帧剧照。",
    `目标总时长：${targetDuration}s。`,
    "镜头节奏硬约束：",
    ...buildShotPolicyLines(targetDuration, resolvedPolicyContext).map((line) => `- ${line}`),
    "配音、旁白和角色台词必须使用中文普通话；没有台词的镜头不要生成口型。",
    "画面中禁止出现字幕、caption、硬字幕、对话气泡、标题卡或任何可读文字。",
    mediaPromptSafetyInstruction(),
    "故事板图上的文字只作为制作备注理解，不要渲染成视频画面文字。",
    "保持项目既定画风、角色身份、服装、场景关系和镜头连续性。",
    "",
    "分镜头脚本：",
    truncateText(shotScript, 3000),
  ]
    .filter(Boolean)
    .join("\n");
  return truncateTextByUtf8Bytes(prompt, MAX_VIDEO_PROMPT_BYTES);
}

async function runScriptJob(firstScriptId: number, jobToken: string) {
  const row = await u.db("o_storyboardFirstScript").where({ id: firstScriptId, jobToken, state: "生成中" }).first();
  if (!row) return;
  try {
    const shotScript = await createShotScript({
      project: {
        id: Number(row.projectId),
        name: row.projectName,
        projectType: row.projectType,
        type: row.projectType,
        artStyle: row.artStyle,
        directorManual: row.directorManual,
      },
      scriptName: "",
      scriptContent: row.scriptContentSnapshot || "",
      targetDuration: Number(row.targetDuration || 10),
      assetSnapshotText: row.assetSnapshot || "",
    });
    const shotScriptHash = computeShotScriptHash(shotScript);
    await u
      .db("o_storyboardFirstScript")
      .where({ id: firstScriptId, jobToken, state: "生成中" })
      .update({
        shotScript,
        shotScriptHash,
        segmentCount: getShotScriptHeadings(shotScript).length || recommendedSegmentCount(Number(row.targetDuration || 10)),
        state: "已完成" as StoryboardFirstState,
        errorReason: "",
        updateTime: Date.now(),
      });
  } catch (e) {
    await u
      .db("o_storyboardFirstScript")
      .where({ id: firstScriptId, jobToken, state: "生成中" })
      .update({
        state: "生成失败" as StoryboardFirstState,
        errorReason: u.error(e).message,
        updateTime: Date.now(),
      });
  }
}

async function runImageJob(firstImageId: number, jobToken: string) {
  const imageRow = await u.db("o_storyboardFirstImage").where({ id: firstImageId, jobToken, state: "生成中" }).first();
  if (!imageRow) return;
  const firstScript = await u.db("o_storyboardFirstScript").where("id", imageRow.firstScriptId).first();
  if (!firstScript) return;
  const filePath = `/${imageRow.projectId}/storyboardFirst/${uuidv4()}.jpg`;
  const thumbPath = `/${imageRow.projectId}/storyboardFirst/thumb/${uuidv4()}.webp`;
  try {
    const project = await getProjectContext(Number(imageRow.projectId));
    const assets = JSON.parse(imageRow.referenceSnapshot || "[]");
    const referenceList = await buildImageReferences(assets);
    const aiImage = await u.Ai.Image(imageRow.imageModel as `${string}:${string}`).run(
      {
        prompt: imageRow.imagePrompt || "",
        referenceList,
        size: (imageRow.imageQuality || "2K") as "1K" | "2K" | "4K",
        aspectRatio: STORYBOARD_FIRST_ASPECT_RATIO,
      },
      {
        projectId: Number(imageRow.projectId),
        taskClass: "生成故事板先行图片",
        describe: `根据分镜脚本生成故事板先行图片，画风：${project.artStyle || "未指定"}`,
        relatedObjects: JSON.stringify({
          projectId: imageRow.projectId,
          scriptId: imageRow.scriptId,
          firstScriptId: imageRow.firstScriptId,
          firstImageId,
          sourceType: "storyboardFirst",
          referenceCount: referenceList.length,
        }),
      },
    );
    await aiImage.save(filePath);
    await saveImageThumbnail(filePath, thumbPath);
    const updated = await u
      .db("o_storyboardFirstImage")
      .where({ id: firstImageId, jobToken, state: "生成中" })
      .update({
        filePath,
        thumbPath,
        isCurrent: 1,
        state: "已完成" as StoryboardFirstState,
        errorReason: "",
        updateTime: Date.now(),
      });
    if (!updated) {
      await cleanupTempImageFiles(filePath, thumbPath);
      return;
    }
    const oldImages = await u
      .db("o_storyboardFirstImage")
      .where({ firstScriptId: imageRow.firstScriptId })
      .whereNot("id", firstImageId)
      .select("id");
    await cleanupStoryboardFirstImagesByIds(oldImages.map((item: any) => Number(item.id)));
  } catch (e) {
    await cleanupTempImageFiles(filePath, thumbPath);
    await u
      .db("o_storyboardFirstImage")
      .where({ id: firstImageId, jobToken, state: "生成中" })
      .update({
        state: "生成失败" as StoryboardFirstState,
        errorReason: u.error(e).message,
        updateTime: Date.now(),
      });
  }
}

async function cleanupTempImageFiles(filePath: string, thumbPath: string) {
  await Promise.all(
    [filePath, thumbPath].map(async (path) => {
      try {
        if (await u.oss.fileExists(path)) await u.oss.deleteFile(path);
      } catch {}
    }),
  );
}

async function isCurrentVideoJob(firstVideoId: number, jobToken: string) {
  const row = await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken, state: "生成中" }).first();
  return !!row;
}

async function isValidVideoJob(firstVideoId: number, jobToken: string) {
  const row = await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken }).whereNot("state", "已取消").first();
  return !!row;
}

async function runVideoJob(firstVideoId: number, jobToken: string, req?: any) {
  const videoRow = await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken, state: "生成中" }).first();
  if (!videoRow) return;
  const image = await u.db("o_storyboardFirstImage").where("id", videoRow.firstImageId).first();
  if (!image?.filePath) return;
  const referencePath = image.videoReferencePath || image.filePath;
  const videoPath = `/${videoRow.projectId}/video/${uuidv4()}.mp4`;
  try {
    const model = String(videoRow.model || "");
    const aiVideo = u.Ai.Video(model as `${string}:${string}`);
    const referenceImage = shouldUsePublicImageReference(model)
      ? await getPublicOssFileUrl(referencePath, req)
      : await u.oss.getImageBase64(referencePath);
    await aiVideo.run(
      {
        prompt: videoRow.prompt || "",
        referenceList: [{ type: "image", base64: referenceImage }],
        mode: ["singleImage"],
        duration: Number(videoRow.duration),
        aspectRatio: STORYBOARD_FIRST_ASPECT_RATIO,
        resolution: videoRow.resolution || "",
        audio: !!videoRow.audio,
        preserveRemoteUrl: true,
        onTaskCreated: async (externalTaskId: string) => {
          if (!(await isCurrentVideoJob(firstVideoId, jobToken))) return;
          await u.db("o_video").where("id", videoRow.videoId).update({ externalTaskId });
        },
      },
      {
        projectId: Number(videoRow.projectId),
        taskClass: "故事板先行转视频",
        describe: "根据故事板先行图片和分镜脚本生成视频",
        relatedObjects: JSON.stringify({
          projectId: videoRow.projectId,
          scriptId: videoRow.scriptId,
          firstScriptId: videoRow.firstScriptId,
          firstImageId: videoRow.firstImageId,
          firstVideoId,
          videoId: videoRow.videoId,
        }),
      },
    );
    if (!(await isCurrentVideoJob(firstVideoId, jobToken))) return;

    const remoteUrl = aiVideo.getRemoteUrl();
    if (remoteUrl) {
      await u.db("o_video").where("id", videoRow.videoId).update({
        state: "已完成",
        remoteUrl,
        remoteUrlExpireTime: Date.now() + REMOTE_VIDEO_URL_TTL_MS,
        localSaveState: "保存中",
        localSaveErrorReason: "",
      });
      await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken, state: "生成中" }).update({
        state: "已完成" as StoryboardFirstState,
        errorReason: "",
        updateTime: Date.now(),
      });
      aiVideo
        .save(videoPath)
        .then(async () => {
          if (!(await isValidVideoJob(firstVideoId, jobToken))) {
            await cleanupTempImageFiles(videoPath, "");
            return;
          }
          await u.db("o_video").where("id", videoRow.videoId).update({
            filePath: videoPath,
            localSaveState: "已保存",
            localSaveErrorReason: "",
          });
        })
        .catch(async (saveError: any) => {
          await u.db("o_video").where("id", videoRow.videoId).update({
            localSaveState: "保存失败",
            localSaveErrorReason: u.error(saveError).message,
          });
        });
      return;
    }

    await aiVideo.save(videoPath);
    if (!(await isCurrentVideoJob(firstVideoId, jobToken))) {
      await cleanupTempImageFiles(videoPath, "");
      return;
    }
    await u.db("o_video").where("id", videoRow.videoId).update({
      state: "已完成",
      filePath: videoPath,
      localSaveState: "已保存",
      localSaveErrorReason: "",
    });
    await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken, state: "生成中" }).update({
      state: "已完成" as StoryboardFirstState,
      errorReason: "",
      updateTime: Date.now(),
    });
  } catch (e) {
    const message = u.error(e).message;
    await u.db("o_video").where("id", videoRow.videoId).update({
      state: "生成失败",
      errorReason: message,
    });
    await u.db("o_storyboardFirstVideo").where({ id: firstVideoId, jobToken, state: "生成中" }).update({
      state: "生成失败" as StoryboardFirstState,
      errorReason: message,
      updateTime: Date.now(),
    });
  }
}

export async function getStoryboardFirstState(projectId: number, scriptId: number) {
  const script = await u
    .db("o_storyboardFirstScript")
    .where({ projectId, scriptId })
    .whereIn("state", ["生成中", "已完成", "生成失败"])
    .orderBy("createTime", "desc")
    .first();
  if (!script) return { script: null, image: null, latestVideo: null, videoHistory: [] };

  const runningImage = await u.db("o_storyboardFirstImage").where({ firstScriptId: script.id, state: "生成中" }).orderBy("createTime", "desc").first();
  const currentImage = await u.db("o_storyboardFirstImage").where({ firstScriptId: script.id, isCurrent: 1 }).orderBy("version", "desc").first();
  const fallbackImage = await u.db("o_storyboardFirstImage").where({ firstScriptId: script.id }).orderBy("createTime", "desc").first();
  const image = runningImage || currentImage || fallbackImage || null;
  const imageStale = !!image && (image.shotScriptHash !== script.shotScriptHash || Number(image.scriptRevision) !== Number(script.scriptRevision));

  const videoRows = await u.db("o_storyboardFirstVideo").where({ firstScriptId: script.id }).orderBy("createTime", "desc");
  const videoIds = videoRows.map((item: any) => Number(item.videoId)).filter((id: number) => Number.isInteger(id));
  const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
  const videoMap = new Map(videos.map((video: any) => [Number(video.id), video]));

  const videoHistory = await Promise.all(
    videoRows.map(async (row: any) => {
      const linkedVideo = videoMap.get(Number(row.videoId));
      const normalizedState = normalizeVideoState(linkedVideo?.state || row.state);
      const errorReason = linkedVideo?.errorReason || row.errorReason || "";
      if (normalizedState !== row.state || errorReason !== (row.errorReason || "")) {
        await u.db("o_storyboardFirstVideo").where("id", row.id).update({
          state: normalizedState,
          errorReason,
          updateTime: Date.now(),
        });
      }
      const stale =
        !image ||
        imageStale ||
        row.imageSourceHash !== image.imageSourceHash ||
        Number(row.firstImageVersion) !== Number(image.version);
      return {
        id: row.id,
        videoId: row.videoId,
        src: linkedVideo ? await getRenderableVideoSrc(linkedVideo) : "",
        imageSourceHash: row.imageSourceHash,
        stale,
        duration: row.duration,
        resolution: row.resolution,
        aspectRatio: row.aspectRatio || STORYBOARD_FIRST_ASPECT_RATIO,
        state: normalizedState,
        errorReason,
      };
    }),
  );

  const imageUrl = image?.filePath ? await u.oss.getFileUrl(image.filePath) : "";
  const thumbUrl = image?.thumbPath
    ? await u.oss.getFileUrl(image.thumbPath)
    : imageUrl
      ? u.oss.buildImagePreviewUrl(imageUrl, { width: 640, format: "webp" })
      : "";

  return {
    script: {
      id: script.id,
      shotScript: script.shotScript || "",
      scriptRevision: script.scriptRevision,
      shotScriptHash: script.shotScriptHash || "",
      state: script.state,
      errorReason: script.errorReason || "",
      targetDuration: script.targetDuration,
      segmentCount: script.segmentCount,
    },
    image: image
      ? {
          id: image.id,
          imageUrl,
          thumbUrl,
          version: image.version,
          imageSourceHash: image.imageSourceHash || "",
          videoReferencePath: image.videoReferencePath || "",
          videoReferenceMode: image.videoReferenceMode || "",
          stale: imageStale,
          state: image.state,
          errorReason: image.errorReason || "",
        }
      : null,
    latestVideo: videoHistory[0] || null,
    videoHistory,
  };
}

export async function startGenerateStoryboardFirstScript(input: {
  projectId: number;
  scriptId: number;
  targetDuration?: number;
  force?: boolean;
}) {
  const project = await getProjectContext(input.projectId);
  const script = await getScript(input.projectId, input.scriptId);
  const targetDuration = resolveTargetDuration(input.targetDuration);
  const assets = await getAssetsSnapshot(input.projectId, input.scriptId);
  const inputHash = computeInputHash({
    scriptContent: script.content || "",
    targetDuration,
    project,
    assetHash: assets.hash,
  });

  const result = await u.db.transaction(async (trx: any) => {
    const existing = !input.force
      ? await trx("o_storyboardFirstScript").where({ projectId: input.projectId, scriptId: input.scriptId, inputHash, state: "已完成" }).orderBy("createTime", "desc").first()
      : null;
    if (existing) return { id: existing.id, reused: true, jobToken: "" };

    const running = await trx("o_storyboardFirstScript").where({ projectId: input.projectId, scriptId: input.scriptId, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) return { id: running.id, reused: true, jobToken: "" };

    const jobToken = uuidv4();
    const now = Date.now();
    const [id] = await trx("o_storyboardFirstScript").insert({
      projectId: input.projectId,
      scriptId: input.scriptId,
      inputHash,
      shotScriptHash: "",
      scriptRevision: 1,
      promptVersion: SCRIPT_PROMPT_VERSION,
      jobToken,
      scriptContentSnapshot: truncateText(script.content || "", MAX_SCRIPT_CONTENT_LENGTH),
      projectName: project.name || "",
      projectType: project.projectType || project.type || "",
      artStyle: project.artStyle || "",
      directorManual: project.directorManual || "",
      targetDuration,
      segmentCount: recommendedSegmentCount(targetDuration),
      shotScript: "",
      assetSnapshot: assets.text,
      state: "生成中" as StoryboardFirstState,
      errorReason: "",
      createTime: now,
      updateTime: now,
    });
    return { id, reused: false, jobToken };
  });
  if (!result.reused) runScriptJob(Number(result.id), result.jobToken);
  return { id: result.id, reused: result.reused };
}

export async function updateStoryboardFirstScript(firstScriptId: number, shotScript: string) {
  const row = await u.db("o_storyboardFirstScript").where("id", firstScriptId).first();
  if (!row) throw new Error("故事板先行分镜脚本不存在");
  const normalizedScript = stripCodeFence(String(shotScript || "").trim());
  if (!normalizedScript) throw new Error("分镜脚本不能为空");
  const now = Date.now();
  const revision = Number(row.scriptRevision || 1) + 1;
  const shotScriptHash = computeShotScriptHash(normalizedScript);
  await u.db("o_storyboardFirstScript").where("id", firstScriptId).update({
    shotScript: truncateText(normalizedScript, MAX_SHOT_SCRIPT_LENGTH),
    shotScriptHash,
    scriptRevision: revision,
    segmentCount: getShotScriptHeadings(normalizedScript).length || row.segmentCount || 1,
    state: "已完成" as StoryboardFirstState,
    errorReason: "",
    jobToken: uuidv4(),
    updateTime: now,
  });
  await u
    .db("o_storyboardFirstImage")
    .where({ firstScriptId })
    .where("state", "生成中")
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "分镜脚本已更新", invalidatedAt: now, updateTime: now });
  await u
    .db("o_storyboardFirstImage")
    .where({ firstScriptId })
    .update({ invalidatedAt: now, updateTime: now });
  await u
    .db("o_storyboardFirstVideo")
    .where({ firstScriptId })
    .where("state", "生成中")
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "分镜脚本已更新", updateTime: now });
  return { id: firstScriptId };
}

export async function startGenerateStoryboardFirstImage(firstScriptId: number, force = false) {
  const firstScript = await u.db("o_storyboardFirstScript").where("id", firstScriptId).first();
  if (!firstScript) throw new Error("故事板先行分镜脚本不存在");
  if (firstScript.state !== "已完成" || !firstScript.shotScript) throw new Error("分镜脚本尚未生成完成");
  const project = await getProjectContext(Number(firstScript.projectId));
  if (!project.imageModel) throw new Error("项目未配置图片生成模型");
  const assets = await getAssetsSnapshot(Number(firstScript.projectId), Number(firstScript.scriptId));
  const imageQuality = (project.imageQuality || "2K") as "1K" | "2K" | "4K";
  const imageSourceHash = computeImageSourceHash({
    firstScript,
    project,
    imageModel: project.imageModel,
    imageQuality,
    assetHash: assets.hash,
  });

  const imagePrompt = buildImagePrompt(firstScript.shotScript, project, Number(firstScript.targetDuration || 10), assets.text);
  const result = await u.db.transaction(async (trx: any) => {
    const existingCurrent = await trx("o_storyboardFirstImage")
      .where({ firstScriptId, imageSourceHash, isCurrent: 1, state: "已完成" })
      .orderBy("version", "desc")
      .first();
    if (existingCurrent && !force) return { id: existingCurrent.id, reused: true, jobToken: "" };

    const running = await trx("o_storyboardFirstImage").where({ firstScriptId, imageSourceHash, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) return { id: running.id, reused: true, jobToken: "" };

    const versionRow = await trx("o_storyboardFirstImage").where({ firstScriptId }).max("version as maxVersion").first();
    const version = Number(versionRow?.maxVersion || 0) + 1;
    const jobToken = uuidv4();
    const now = Date.now();
    const [id] = await trx("o_storyboardFirstImage").insert({
      projectId: firstScript.projectId,
      scriptId: firstScript.scriptId,
      firstScriptId,
      scriptRevision: firstScript.scriptRevision,
      shotScriptHash: firstScript.shotScriptHash,
      shotScriptSnapshot: firstScript.shotScript,
      filePath: "",
      thumbPath: "",
      imagePrompt,
      imageModel: project.imageModel,
      imageQuality,
      ratio: STORYBOARD_FIRST_ASPECT_RATIO,
      imageSourceHash,
      assetHash: assets.hash,
      referenceSnapshot: JSON.stringify(assets.rows),
      version,
      isCurrent: 0,
      invalidatedAt: 0,
      jobToken,
      state: "生成中" as StoryboardFirstState,
      errorReason: "",
      createTime: now,
      updateTime: now,
    });
    return { id, reused: false, jobToken };
  });
  if (!result.reused) runImageJob(Number(result.id), result.jobToken);
  return { id: result.id, reused: result.reused };
}

export async function regenerateStoryboardFirstImage(firstImageId: number) {
  const image = await u.db("o_storyboardFirstImage").where("id", firstImageId).first();
  if (!image) throw new Error("故事板先行图片不存在");
  return startGenerateStoryboardFirstImage(Number(image.firstScriptId), true);
}

export async function startGenerateStoryboardFirstVideo(input: {
  firstImageId: number;
  model: string;
  duration: number;
  resolution: string;
  audio?: boolean;
  req?: any;
}) {
  const image = await u.db("o_storyboardFirstImage").where("id", input.firstImageId).first();
  if (!image) throw new Error("故事板先行图片不存在");
  if (image.state !== "已完成" || !image.filePath) throw new Error("故事板图片尚未生成完成");
  const firstScript = await u.db("o_storyboardFirstScript").where("id", image.firstScriptId).first();
  if (!firstScript) throw new Error("故事板先行分镜脚本不存在");
  const stale = image.shotScriptHash !== firstScript.shotScriptHash || Number(image.scriptRevision) !== Number(firstScript.scriptRevision);
  if (stale) throw new Error("故事板图片已过期，请先重新生成故事板图片");

  const detail = await getVideoModelDetail(input.model);
  const effectiveDuration = resolveVideoGenerationDuration(input.model, input.duration, detail.name, detail.durationResolutionMap);
  const policyContext: ShotPolicyContext = {
    videoModel: input.model,
    videoModelName: detail.name || detail.modelName || null,
  };
  const resolution = resolveVideoResolution(detail, effectiveDuration, input.resolution);
  if (input.audio && detail.audio === false) throw new Error("当前模型不支持生成音频");

  const videoReference = await generateStoryboardFirstVideoReference({
    imageRow: image,
    firstScript,
    modelDetail: detail,
    targetDuration: effectiveDuration,
  });
  const referenceViolations = validateStoryboardVideoReferenceResult(videoReference, effectiveDuration, policyContext);
  if (referenceViolations.length) {
    throw new Error(`视频参考图预检失败：${referenceViolations.join("；")}`);
  }

  const prompt = renderStoryboardVideoReferencePrompt(videoReference, effectiveDuration);
  const result = await u.db.transaction(async (trx: any) => {
    const running = await trx("o_storyboardFirstVideo").where({ firstImageId: input.firstImageId, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) return { id: running.id, videoId: running.videoId, reused: true, jobToken: "" };

    const now = Date.now();
    const jobToken = uuidv4();
    const videoPath = `/${image.projectId}/video/${uuidv4()}.mp4`;
    const [videoId] = await trx("o_video").insert({
      filePath: videoPath,
      time: now,
      state: "生成中",
      localSaveState: "未保存",
      scriptId: image.scriptId,
      projectId: image.projectId,
      videoTrackId: null,
    });
    const [id] = await trx("o_storyboardFirstVideo").insert({
      projectId: image.projectId,
      scriptId: image.scriptId,
      firstScriptId: image.firstScriptId,
      firstImageId: input.firstImageId,
      videoId,
      imageSourceHash: image.imageSourceHash,
      firstImageVersion: image.version,
      model: input.model,
      prompt,
      duration: effectiveDuration,
      resolution,
      aspectRatio: STORYBOARD_FIRST_ASPECT_RATIO,
      audio: input.audio ? 1 : 0,
      jobToken,
      state: "生成中" as StoryboardFirstState,
      errorReason: "",
      createTime: now,
      updateTime: now,
    });
    return { id, videoId, reused: false, jobToken };
  });
  if (!result.reused) runVideoJob(Number(result.id), result.jobToken, input.req);
  return { id: result.id, videoId: result.videoId, reused: result.reused };
}

export async function deleteStoryboardFirst(input: { firstScriptId?: number; firstImageId?: number }) {
  const hasScript = Number.isInteger(Number(input.firstScriptId));
  const hasImage = Number.isInteger(Number(input.firstImageId));
  if (hasScript === hasImage) throw new Error("firstScriptId 和 firstImageId 必须且只能传一个");
  if (hasScript) {
    const script = await u.db("o_storyboardFirstScript").where("id", input.firstScriptId).first();
    if (!script) throw new Error("故事板先行分镜脚本不存在");
    await cleanupStoryboardFirstByProjectScript(Number(script.projectId), Number(script.scriptId));
    return true;
  }
  await cleanupStoryboardFirstImagesByIds([Number(input.firstImageId)]);
  return true;
}

export async function clearStoryboardFirstWorkflow(projectId: number, scriptId: number, confirm: boolean) {
  if (confirm !== true) throw new Error("清空故事板先行工作流需要 confirm=true");
  await cleanupStoryboardFirstByProjectScript(projectId, scriptId);
  return true;
}
