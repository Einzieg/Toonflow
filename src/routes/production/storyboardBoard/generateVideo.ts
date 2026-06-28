import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { REMOTE_VIDEO_URL_TTL_MS, getPublicOssFileUrl } from "@/utils/videoSource";
import type { StoryboardBoardInput } from "@/utils/storyboardBoard";
import { resolveVideoGenerationDuration, shouldUsePublicImageReferenceForVideoModel } from "@/utils/storyboardTrack";
import { resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { minShotCount, recommendedShotCount, resolveMaxShotDurationSeconds, type ShotPolicyContext } from "@/utils/shotPolicy";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";
import { mediaPromptSafetyInstruction } from "@/utils/promptSafety";
import {
  cleanupStoryboardVideoReferenceFiles,
  createStoryboardVideoReference,
  fitStoryboardVideoReferenceDuration,
  generateStoryboardVideoReferencePromptWithAI,
  limitStoryboardVideoReferencePrompt,
  validateStoryboardVideoReferenceResult,
  type CharacterVoiceSetting,
  type ShotFrameSource,
} from "@/utils/storyboardVideoReference";

const router = express.Router();

class StoryboardBoardVideoInputError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseStoryboardIds(value?: string | null): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function modeSupportsSingleImage(mode: unknown) {
  if (!Array.isArray(mode)) return false;
  return mode.some((item) => item === "singleImage" || (Array.isArray(item) && item.includes("singleImage")));
}

async function getVideoModelDetail(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
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
        (Array.isArray(item.resolution) ? item.resolution : []).forEach((resolution: any) => {
          if (resolution) resolutions.add(String(resolution));
        });
      }
    });
  }
  return Array.from(resolutions);
}

function shouldUsePublicImageReference(model: string) {
  return shouldUsePublicImageReferenceForVideoModel(model);
}

function getVideoPromptLimitBytes(model: string) {
  const [vendorId, modelName = ""] = String(model || "").split(/:(.+)/);
  const lower = `${vendorId}:${modelName}`.toLowerCase();
  if (vendorId === "cliproxyapi" || lower.includes("grok")) return 3000;
  return 3900;
}

function extractMarkedField(value: string, name: string) {
  const match = value.match(new RegExp(`【${name}】([^【]+)`));
  return String(match?.[1] || "").trim();
}

function normalizeText(value?: string | number | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildRoleVoiceSettings(refRows: any[]): CharacterVoiceSetting[] {
  const map = new Map<string, CharacterVoiceSetting>();
  refRows
    .filter((item) => item.type === "role")
    .forEach((item) => {
      const name = normalizeText(item.baseName || item.name);
      if (!name) return;
      const voiceProfile = normalizeText(item.voiceProfile);
      const voiceTone = normalizeText(item.voiceTone);
      const speechRate = normalizeText(item.speechRate);
      if (!voiceProfile && !voiceTone && !speechRate) return;
      const existing = map.get(name);
      map.set(name, {
        name,
        voiceProfile: normalizeText(existing?.voiceProfile) || voiceProfile || null,
        voiceTone: normalizeText(existing?.voiceTone) || voiceTone || null,
        speechRate: normalizeText(existing?.speechRate) || speechRate || null,
      });
    });
  return Array.from(map.values());
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 18)).trim()}...（已截断）`;
}

function normalizeImageQuality(value: unknown): "1K" | "2K" | "4K" {
  const text = String(value || "");
  return text === "1K" || text === "2K" || text === "4K" ? text : "2K";
}

function parseShotFrameSource(row: any, index: number, refsByStoryboardId: Map<number, any[]>): ShotFrameSource {
  const videoDesc = String(row.videoDesc || "");
  const shotText = extractMarkedField(videoDesc, "镜头");
  const [shotSize = "", cameraMove = ""] = shotText.split(/[，,]/).map((item) => item.trim());
  const refRows = refsByStoryboardId.get(Number(row.id)) || [];
  const characters = refRows.filter((item) => item.type === "role").map((item) => item.name || item.baseName);
  const roleVoiceSettings = buildRoleVoiceSettings(refRows);
  const props = refRows.filter((item) => item.type === "tool").map((item) => item.name || item.baseName);
  const sceneFromAsset = refRows.find((item) => item.type === "scene")?.name;

  return {
    shotNo: index + 1,
    sourceStoryboardId: Number(row.id),
    filePath: String(row.filePath || ""),
    duration: Number(row.duration || 0),
    visualObjective: extractMarkedField(videoDesc, "画面") || String(row.prompt || "").slice(0, 220),
    actionUnit: extractMarkedField(videoDesc, "动作") || extractMarkedField(videoDesc, "画面") || String(row.prompt || "").slice(0, 220),
    cameraMove: cameraMove || "按分镜图执行",
    shotSize: shotSize || "按分镜图执行",
    emotion: extractMarkedField(videoDesc, "情绪") || "按分镜图执行",
    dialogue: extractMarkedField(videoDesc, "台词") || "无台词",
    scene: extractMarkedField(videoDesc, "场景") || sceneFromAsset || "",
    characters,
    roleVoiceSettings,
    props,
    owned: false,
  };
}

interface ShotScriptSection {
  shotNo: number;
  duration: number;
  text: string;
}

function parseShotScriptSections(shotScript: string, fallbackDuration: number): ShotScriptSection[] {
  const lines = String(shotScript || "").split(/\r?\n/);
  const sections: Array<{ shotNo: number; duration: number; lines: string[] }> = [];
  let current: { shotNo: number; duration: number; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    sections.push(current);
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

  if (!sections.length) return [];

  const hasMissingDuration = sections.some((item) => !Number.isFinite(item.duration) || item.duration <= 0);
  const averageDuration = fallbackDuration / sections.length;
  return sections.map((item, index) => ({
    shotNo: item.shotNo || index + 1,
    duration:
      Number.isFinite(item.duration) && item.duration > 0
        ? Number(item.duration.toFixed(3))
        : Number((index === sections.length - 1 ? fallbackDuration - averageDuration * (sections.length - 1) : averageDuration).toFixed(3)),
    text: item.lines.join("\n").trim(),
  }));
}

function fitShotScriptSectionDurations(sections: ShotScriptSection[], targetDuration: number) {
  const target = Number(targetDuration);
  if (!Number.isFinite(target) || target <= 0 || !sections.length) return sections;
  const total = sections.reduce((sum, item) => sum + Number(item.duration || 0), 0);
  if (!Number.isFinite(total) || total <= 0) return sections;

  let cursor = 0;
  return sections.map((item, index) => {
    const isLast = index === sections.length - 1;
    const duration = isLast ? target - cursor : (Number(item.duration || 0) / total) * target;
    const normalized = Math.max(0.001, Number(duration.toFixed(3)));
    cursor += normalized;
    return { ...item, duration: normalized };
  });
}

function splitSection(section: ShotScriptSection, parts: number): ShotScriptSection[] {
  const count = Math.max(1, parts);
  const baseDuration = Number((section.duration / count).toFixed(3));
  let used = 0;
  return Array.from({ length: count }, (_, index) => {
    const isLast = index === count - 1;
    const duration = isLast ? Number((section.duration - used).toFixed(3)) : baseDuration;
    used += duration;
    return {
      shotNo: section.shotNo,
      duration,
      text:
        count === 1
          ? section.text
          : [
              section.text,
              `- 视频参考帧拆分：这是该镜头的第 ${index + 1}/${count} 个连续动作阶段，保持同一剧情事实，但用不同景别、构图或动作瞬间表现节奏变化。`,
            ].join("\n"),
    };
  });
}

function enforceShotScriptSectionPolicy(sections: ShotScriptSection[], targetDuration: number, policyContext?: ShotPolicyContext | null) {
  const target = Number(targetDuration);
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);
  const desiredCount = Math.max(minShotCount(target, policyContext), Math.min(recommendedShotCount(target), 7));
  let normalized = fitShotScriptSectionDurations(sections, target).flatMap((section) => {
    const parts = Math.ceil(Number(section.duration || 0) / maxShotDuration);
    return splitSection(section, parts);
  });

  while (normalized.length < desiredCount && normalized.length > 0) {
    let longestIndex = 0;
    normalized.forEach((item, index) => {
      if (item.duration > normalized[longestIndex].duration) longestIndex = index;
    });
    const [longest] = normalized.splice(longestIndex, 1);
    normalized.splice(longestIndex, 0, ...splitSection(longest, 2));
  }

  return fitShotScriptSectionDurations(
    normalized.map((section, index) => ({ ...section, shotNo: index + 1 })),
    target,
  );
}

function extractShotScriptLine(sectionText: string, label: string) {
  const match = sectionText.match(new RegExp(`-\\s*${label}：([^\\n]+)`));
  return normalizeText(match?.[1] || "");
}

function buildVisualOnlyFramePrompt(sectionText: string, project: any, hasPreviousFrame: boolean) {
  return buildStoryboardImagePrompt(
    [
      "Generate one vertical visual-only cinematic key frame for this storyboard video reference.",
      "No text, no subtitles, no captions, no title card, no labels, no UI, no speech bubbles, no watermark.",
      "Do not draw a storyboard page, panel border, shot label, duration label, production note, or any readable writing.",
      mediaPromptSafetyInstruction(),
      hasPreviousFrame
        ? "A previous generated reference frame is provided first. Continue its character identity, clothing, spatial continuity, lighting, and action flow; create the next moment, not a duplicate."
        : "This is the first generated reference frame. Establish the visual continuity clearly for following frames.",
      `Project art style ID: ${project.artStyle || "unspecified"}. Keep exactly this project style.`,
      `Director manual: ${truncateText(normalizeText(project.directorManual), 500) || "unspecified"}.`,
      "Use the shot script below only as visual direction:",
      truncateText(sectionText, 1200),
    ].join("\n"),
    project.artStyle,
  );
}

function pushUniquePath(paths: string[], value?: string | null) {
  const path = normalizeText(value);
  if (!path || paths.includes(path)) return;
  paths.push(path);
}

async function buildFrameGenerationReferences(storyboards: StoryboardBoardInput[], assetRefs: any[], reservedSlots = 0) {
  const paths: string[] = [];
  assetRefs.forEach((item) => pushUniquePath(paths, item.filePath));
  storyboards.forEach((item) => pushUniquePath(paths, item.filePath));
  const selectedPaths = paths.slice(0, Math.max(0, 7 - reservedSlots));
  if (!selectedPaths.length) return [];

  const budget = getReferenceImageBudget(selectedPaths.length + reservedSlots);
  const references = await Promise.all(
    selectedPaths.map(async (filePath) => {
      try {
        const url = await u.oss.getFileUrl(filePath);
        return { type: "image" as const, base64: await urlToCompressedBase64(url, budget) };
      } catch (e) {
        console.warn("[storyboardBoard.videoReferenceFrame] 参考图读取失败:", filePath, u.error(e).message);
        return null;
      }
    }),
  );
  return references.filter((item): item is { type: "image"; base64: string } => item != null);
}

async function cleanupGeneratedFrameFiles(frames: ShotFrameSource[]) {
  await Promise.all(
    frames
      .filter((item) => item.owned)
      .map(async (item) => {
        try {
          if (await u.oss.fileExists(item.filePath)) await u.oss.deleteFile(item.filePath);
        } catch {}
      }),
  );
}

async function buildShotScriptVideoReferenceFrames(input: {
  board: any;
  project: any;
  storyboards: StoryboardBoardInput[];
  assetRefs: any[];
  targetDuration: number;
  policyContext?: ShotPolicyContext | null;
}): Promise<ShotFrameSource[]> {
  const rawSections = parseShotScriptSections(String(input.board.shotScript || ""), input.targetDuration);
  if (!rawSections.length) return [];
  const sections = enforceShotScriptSectionPolicy(rawSections, input.targetDuration, input.policyContext);
  const baseReferenceList = await buildFrameGenerationReferences(input.storyboards, input.assetRefs, sections.length > 1 ? 1 : 0);
  const characters = Array.from(new Set(input.assetRefs.filter((item) => item.type === "role").map((item) => item.name || item.baseName).filter(Boolean)));
  const roleVoiceSettings = buildRoleVoiceSettings(input.assetRefs);
  const props = Array.from(new Set(input.assetRefs.filter((item) => item.type === "tool").map((item) => item.name || item.baseName).filter(Boolean)));
  const scene = input.assetRefs.find((item) => item.type === "scene")?.name || "";
  const imageModel = String(input.board.imageModel || input.project.imageModel || "");
  if (!imageModel) throw new Error("项目未配置图片生成模型，无法生成视频参考帧");

  const frames: ShotFrameSource[] = [];
  let previousFrameReference: { type: "image"; base64: string } | null = null;
  for (const [sectionIndex, section] of sections.entries()) {
    const filePath = `/${input.board.projectId}/storyboardBoard/videoReferenceFrames/${uuidv4()}.jpg`;
    const referenceList = previousFrameReference ? [previousFrameReference, ...baseReferenceList].slice(0, 7) : baseReferenceList;
    const prompt = buildVisualOnlyFramePrompt(section.text, input.project, !!previousFrameReference);
    const image = await u.Ai.Image(imageModel as `${string}:${string}`).run(
      {
        prompt,
        referenceList,
        size: normalizeImageQuality(input.project.imageQuality),
        aspectRatio: "9:16",
      },
      {
        projectId: Number(input.board.projectId),
        taskClass: "生成故事板视频参考帧",
        describe: "根据故事板分镜头脚本生成无文字视频参考帧",
        relatedObjects: JSON.stringify({
          projectId: input.board.projectId,
          scriptId: input.board.scriptId,
          boardId: input.board.id,
          sourceType: "storyboardBoardVideoReference",
          shotNo: section.shotNo,
        }),
      },
    );
    await image.save(filePath);
    if (sectionIndex < sections.length - 1) {
      try {
        const url = await u.oss.getFileUrl(filePath);
        previousFrameReference = {
          type: "image",
          base64: await urlToCompressedBase64(url, getReferenceImageBudget(Math.min(7, baseReferenceList.length + 1))),
        };
      } catch (e) {
        console.warn("[storyboardBoard.videoReferenceFrame] 上一帧参考图压缩失败:", filePath, u.error(e).message);
        previousFrameReference = null;
      }
    }
    frames.push({
      shotNo: section.shotNo,
      filePath,
      duration: section.duration,
      visualObjective: extractShotScriptLine(section.text, "画面内容") || section.text,
      actionUnit: extractShotScriptLine(section.text, "角色调度") || extractShotScriptLine(section.text, "画面内容") || section.text,
      cameraMove: extractShotScriptLine(section.text, "运镜") || "按参考帧执行",
      shotSize: extractShotScriptLine(section.text, "景别") || "按参考帧执行",
      emotion: extractShotScriptLine(section.text, "声音/情绪") || "按参考帧执行",
      dialogue: extractShotScriptLine(section.text, "台词/配音") || "无台词",
      scene,
      characters,
      roleVoiceSettings,
      props,
      owned: true,
    });
  }
  return frames;
}

function hasDurationPolicyViolation(videoReference: any, targetDuration: number, policyContext?: ShotPolicyContext | null) {
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);
  return (
    Array.isArray(videoReference?.shotTimeline) &&
    videoReference.shotTimeline.some((item: any) => Number(item?.duration || 0) > maxShotDuration)
  );
}

export async function prepareStoryboardBoardVideoPrompt(input: {
  boardId: number;
  model: string;
  duration: number;
  resolution: string;
  audio?: boolean;
  promptOverride?: string | null;
}) {
  const { boardId, model, duration, resolution, audio = false, promptOverride } = input;
  const board = await u.db("o_storyboardBoard").where("id", boardId).first();
  if (!board) throw new StoryboardBoardVideoInputError("故事板不存在", 404);
  if (board.state !== "已完成" || !board.filePath) throw new StoryboardBoardVideoInputError("故事板未生成完成");
  const projectId = Number(board.projectId);
  const scriptId = Number(board.scriptId);
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) throw new StoryboardBoardVideoInputError("故事板缺少项目或剧集信息");

  let modelDetail: any;
  try {
    modelDetail = await getVideoModelDetail(model);
  } catch (e) {
    throw new StoryboardBoardVideoInputError(u.error(e).message);
  }

  const effectiveDuration = resolveVideoGenerationDuration(model, duration, modelDetail.name, modelDetail.durationResolutionMap);
  const policyContext: ShotPolicyContext = {
    videoModel: model,
    videoModelName: modelDetail.name || modelDetail.modelName || null,
  };
  const supportedResolutions = getSupportedResolutions(modelDetail, effectiveDuration);
  if (supportedResolutions.length && !supportedResolutions.includes(resolution)) {
    throw new StoryboardBoardVideoInputError(`当前模型不支持 ${resolution} 分辨率，可用分辨率：${supportedResolutions.join(", ")}`);
  }
  if (audio && modelDetail.audio === false) {
    throw new StoryboardBoardVideoInputError("当前模型不支持生成音频");
  }
  const project = await u
    .db("o_project")
    .where("id", projectId)
    .select("name", "type", "imageModel", "imageQuality", "artStyle", "directorManual", "videoRatio")
    .first();
  if (!project) throw new StoryboardBoardVideoInputError("项目不存在或已被删除");

  const storyboardIds = parseStoryboardIds(board.storyboardIds);
  const storyboards: StoryboardBoardInput[] = storyboardIds.length
    ? await u.db("o_storyboard").whereIn("id", storyboardIds).orderBy("index", "asc").select("id", "index", "filePath", "duration", "prompt", "videoDesc", "track")
    : [];
  const missingFrame = storyboards.find((item) => !String(item.filePath || "").trim());
  if (missingFrame) {
    const label = `S${String(Number(missingFrame.index ?? 0) + 1).padStart(2, "0")}`;
    throw new StoryboardBoardVideoInputError(`${label} 缺少分镜图，无法生成无文字视频参考图`);
  }

  let videoReference;
  let generatedFrames: ShotFrameSource[] = [];
  try {
    const assetRefs = await resolveEffectiveStoryboardAssetReferences(storyboardIds);
    const refsByStoryboardId = new Map<number, any[]>();
    assetRefs.forEach((ref) => {
      if (!refsByStoryboardId.has(ref.storyboardId)) refsByStoryboardId.set(ref.storyboardId, []);
      refsByStoryboardId.get(ref.storyboardId)!.push(ref);
    });
    const sourceFrames = (storyboards as any[]).map((item, index) => parseShotFrameSource(item, index, refsByStoryboardId));
    let frames = sourceFrames;
    let candidateReference = fitStoryboardVideoReferenceDuration(
      await createStoryboardVideoReference({
        projectId,
        frames,
        modelDetail,
        requestedMode: "auto",
      }),
      effectiveDuration,
    );
    if (String(board.shotScript || "").trim() && hasDurationPolicyViolation(candidateReference, effectiveDuration, policyContext)) {
      await cleanupStoryboardVideoReferenceFiles({
        videoReferencePath: candidateReference.videoReferencePath,
        frameManifest: JSON.stringify(candidateReference.frameManifest),
      });
      frames = await buildShotScriptVideoReferenceFrames({
        board,
        project,
        storyboards,
        assetRefs,
        targetDuration: effectiveDuration,
        policyContext,
      });
      generatedFrames = frames;
      candidateReference = fitStoryboardVideoReferenceDuration(
        await createStoryboardVideoReference({
          projectId,
          frames,
          modelDetail,
          requestedMode: "auto",
        }),
        effectiveDuration,
      );
    }
    videoReference = candidateReference;
    const referenceViolations = validateStoryboardVideoReferenceResult(videoReference, effectiveDuration, policyContext);
    if (referenceViolations.length) {
      await cleanupStoryboardVideoReferenceFiles({
        videoReferencePath: videoReference.videoReferencePath,
        frameManifest: JSON.stringify(videoReference.frameManifest),
      });
      throw new StoryboardBoardVideoInputError(`视频参考图预检失败：${referenceViolations.join("；")}`);
    }
    await cleanupStoryboardVideoReferenceFiles({
      videoReferencePath: board.videoReferencePath,
      frameManifest: board.frameManifest,
    });
    await u.db("o_storyboardBoard").where("id", boardId).update({
      videoReferencePath: videoReference.videoReferencePath,
      videoReferenceMode: videoReference.mode,
      frameManifest: JSON.stringify(videoReference.frameManifest),
      shotTimeline: JSON.stringify(videoReference.shotTimeline),
      lockedNarrative: JSON.stringify(videoReference.lockedNarrative),
      updateTime: Date.now(),
    });
  } catch (e) {
    await cleanupGeneratedFrameFiles(generatedFrames);
    if (e instanceof StoryboardBoardVideoInputError) throw e;
    throw new StoryboardBoardVideoInputError(u.error(e).message);
  }

  const maxPromptBytes = getVideoPromptLimitBytes(model);
  const rawPrompt =
    String(promptOverride || "").trim() ||
    (await generateStoryboardVideoReferencePromptWithAI({
      result: videoReference,
      targetDuration: effectiveDuration,
      model,
      modelDetail,
      project,
      maxBytes: maxPromptBytes,
    }));
  const prompt = limitStoryboardVideoReferencePrompt(rawPrompt, videoReference, effectiveDuration, maxPromptBytes);
  return {
    board,
    projectId,
    scriptId,
    modelDetail,
    effectiveDuration,
    prompt,
    videoReference,
  };
}

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
    model: z.string(),
    duration: z.number(),
    resolution: z.string(),
    audio: z.boolean().optional(),
    prompt: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { boardId, model, duration, resolution, audio = false, prompt: promptOverride } = req.body as {
      boardId: number;
      model: string;
      duration: number;
      resolution: string;
      audio?: boolean;
      prompt?: string | null;
    };

    const board = await u.db("o_storyboardBoard").where("id", boardId).first();
    if (!board) return res.status(404).send(error("故事板不存在"));

    const running = await u.db("o_storyboardBoardVideo").where({ boardId, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) {
      return res.status(200).send(success({ id: running.id, videoId: running.videoId, prompt: running.prompt, reused: true }));
    }

    let prepared: Awaited<ReturnType<typeof prepareStoryboardBoardVideoPrompt>>;
    try {
      prepared = await prepareStoryboardBoardVideoPrompt({
        boardId,
        model,
        duration,
        resolution,
        audio,
        promptOverride,
      });
    } catch (e) {
      const statusCode = e instanceof StoryboardBoardVideoInputError ? e.statusCode : 400;
      return res.status(statusCode).send(error(u.error(e).message));
    }

    const { projectId, scriptId, effectiveDuration, prompt, videoReference } = prepared;
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const now = Date.now();
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: now,
      state: "生成中",
      localSaveState: "未保存",
      scriptId,
      projectId,
      videoTrackId: null,
    });
    const [boardVideoId] = await u.db("o_storyboardBoardVideo").insert({
      boardId,
      projectId,
      scriptId,
      videoId,
      referenceMode: videoReference.mode,
      model,
      prompt,
      duration: effectiveDuration,
      resolution,
      state: "生成中",
      errorReason: "",
      createTime: now,
      updateTime: now,
    });

    res.status(200).send(success({ id: boardVideoId, videoId, prompt }));

    (async () => {
      try {
        const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
        const aiVideo = u.Ai.Video(model as `${string}:${string}`);
        const referencePath = videoReference.referencePaths[0] || videoReference.videoReferencePath;
        const referenceImage = shouldUsePublicImageReference(model) ? await getPublicOssFileUrl(referencePath, req) : await u.oss.getImageBase64(referencePath);
        await aiVideo.run(
          {
            prompt,
            referenceList: [
              {
                type: "image",
                base64: referenceImage,
              },
            ],
            mode: ["singleImage"],
            duration: effectiveDuration,
            aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
            resolution,
            audio,
            preserveRemoteUrl: true,
            onTaskCreated: async (externalTaskId: string) => {
              await u.db("o_video").where("id", videoId).update({ externalTaskId });
            },
          },
          {
            projectId,
            taskClass: "视频生成",
            describe: "根据故事板页和分镜头脚本生成视频",
            relatedObjects: JSON.stringify({
              projectId,
              scriptId,
              boardId,
              videoId,
              type: "故事板视频",
            }),
          },
        );

        const remoteUrl = aiVideo.getRemoteUrl();
        if (remoteUrl) {
          await u.db("o_video").where("id", videoId).update({
            state: "已完成",
            remoteUrl,
            remoteUrlExpireTime: Date.now() + REMOTE_VIDEO_URL_TTL_MS,
            localSaveState: "保存中",
            localSaveErrorReason: "",
          });
          await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
            state: "已完成",
            errorReason: "",
            updateTime: Date.now(),
          });

          aiVideo
            .save(videoPath)
            .then(async () => {
              await u.db("o_video").where("id", videoId).update({
                filePath: videoPath,
                localSaveState: "已保存",
                localSaveErrorReason: "",
              });
            })
            .catch(async (saveError: any) => {
              await u.db("o_video").where("id", videoId).update({
                localSaveState: "保存失败",
                localSaveErrorReason: u.error(saveError).message,
              });
            });
          return;
        }

        await aiVideo.save(videoPath);
        await u.db("o_video").where("id", videoId).update({
          state: "已完成",
          localSaveState: "已保存",
          localSaveErrorReason: "",
        });
        await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
          state: "已完成",
          errorReason: "",
          updateTime: Date.now(),
        });
      } catch (e) {
        const message = u.error(e).message;
        await u.db("o_video").where("id", videoId).update({
          state: "生成失败",
          errorReason: message,
        });
        await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
          state: "生成失败",
          errorReason: message,
          updateTime: Date.now(),
        });
      }
    })();
  },
);
