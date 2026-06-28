import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  formatVideoDurationRange,
  isGrokImagineVideoModel,
  isSeedance2VideoModel,
  resolveVideoModelDurationRange,
  resolveVideoGenerationDuration,
  shouldForceSingleImageReferenceForVideoModel,
  shouldUsePublicImageReferenceForVideoModel,
} from "@/utils/storyboardTrack";
import { REMOTE_VIDEO_URL_TTL_MS, getPublicOssFileUrl } from "@/utils/videoSource";
import { resolveEffectiveAssetReferences, resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { ensureMandarinDialogueLanguageRule, renderMandarinDialogueLanguageRule } from "@/utils/videoPromptDialogueLanguage";
import { ensureTrackSelectedVideoTailFrame, ensureVideoTailFrame } from "@/utils/videoTailFrame";
import path from "node:path";
import sharp from "sharp";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
  referenceImageKind?: "storyboard" | "grid" | "tailFrame";
}

type ReferenceMediaType = "image" | "video" | "audio";
type EffectiveUploadItem = Omit<UploadItem, "sources"> & {
  sources?: "assets" | "storyboard" | string;
  filePath?: string;
};

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
};

const DEFAULT_MIME_BY_TYPE: Record<ReferenceMediaType, string> = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/mpeg",
};
const CLIPROXY_VIDEO_PROMPT_MAX_BYTES = 3000;

function inferReferenceMediaType(filePath: string, typeHint?: string | null): ReferenceMediaType {
  const normalizedHint = String(typeHint || "").toLowerCase();
  if (normalizedHint === "audio") return "audio";
  if (normalizedHint === "video") return "video";
  if (normalizedHint === "image") return "image";

  const ext = path.extname(String(filePath || "").split("?")[0]).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".aac", ".flac", ".m4a"].includes(ext)) return "audio";
  return "image";
}

function getOriginalOssImagePath(filePath: string): string {
  let normalized = String(filePath || "").trim();
  try {
    normalized = new URL(normalized, "http://toonflow.local").pathname;
  } catch {}
  normalized = decodeURIComponent(normalized).replace(/\\/g, "/").replace(/^\/+/, "");
  while (/^(oss-preview|oss)\//.test(normalized)) {
    normalized = normalized.replace(/^(oss-preview|oss)\//, "");
  }
  if (normalized.startsWith("smallImage/")) {
    normalized = normalized.slice("smallImage/".length);
  }
  return normalized ? `/${normalized}` : filePath;
}

async function resolveReferenceFilePath(filePath: string, mediaType: ReferenceMediaType): Promise<string> {
  if (mediaType !== "image") return filePath;
  const originalPath = getOriginalOssImagePath(filePath);
  if (originalPath !== filePath && (await u.oss.fileExists(originalPath))) {
    return originalPath;
  }
  return filePath;
}

async function ensureImageMinShortEdge(fileBuffer: Buffer, minShortEdge: number): Promise<Buffer> {
  if (minShortEdge <= 0) return fileBuffer;
  const metadata = await sharp(fileBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const shortEdge = Math.min(width, height);
  if (!width || !height || shortEdge > minShortEdge) return fileBuffer;

  const scale = (minShortEdge + 1) / shortEdge;
  const nextWidth = Math.ceil(width * scale);
  const nextHeight = Math.ceil(height * scale);
  return sharp(fileBuffer).rotate().resize(nextWidth, nextHeight, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
}

async function filePathToDataUrl(filePath: string, mediaType: ReferenceMediaType, options: { minImageShortEdge?: number } = {}): Promise<string> {
  const resolvedPath = await resolveReferenceFilePath(filePath, mediaType);
  let fileBuffer = await u.oss.getFile(resolvedPath);
  const ext = path.extname(String(resolvedPath || "").split("?")[0]).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || DEFAULT_MIME_BY_TYPE[mediaType];
  if (mediaType === "image" && options.minImageShortEdge) {
    const nextBuffer = await ensureImageMinShortEdge(fileBuffer, options.minImageShortEdge);
    if (nextBuffer !== fileBuffer) {
      fileBuffer = nextBuffer;
      return `data:image/jpeg;base64,${fileBuffer.toString("base64")}`;
    }
  }
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
}

function normalizeVolcengineAssetUri(value?: string | null): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.startsWith("asset://") ? normalized : `asset://${normalized}`;
}

function normalizeText(value?: string | null): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePromptWhitespace(prompt: string) {
  return String(prompt || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatDuration(value: number): string {
  const rounded = Number(value.toFixed(1));
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function enforceGrokTargetDurationPrompt(value: string, targetDuration: number) {
  const durationText = formatDuration(targetDuration);
  const requiredPrefix = `A ${durationText}-second cinematic video clip.`;
  const text = normalizePromptWhitespace(value);
  if (!text) return requiredPrefix;
  if (/^A\s+\d+(?:\.\d+)?-second cinematic video clip\./i.test(text)) {
    return text.replace(/^A\s+\d+(?:\.\d+)?-second cinematic video clip\./i, requiredPrefix);
  }
  return `${requiredPrefix} ${text}`;
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
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const charBytes = getUtf8Bytes(char);
    if (bytes + charBytes > maxBytes) break;
    result = char + result;
    bytes += charBytes;
  }
  return result;
}

function limitCliproxyVideoPrompt(prompt: string) {
  const normalized = normalizePromptWhitespace(prompt);
  const normalizedBytes = getUtf8Bytes(normalized);
  if (normalizedBytes <= CLIPROXY_VIDEO_PROMPT_MAX_BYTES) return normalized;

  const marker = "\n...[prompt compressed to fit upstream prompt limit]...\n";
  const markerBytes = getUtf8Bytes(marker);
  const headBytes = 2000;
  const tailBytes = Math.max(0, CLIPROXY_VIDEO_PROMPT_MAX_BYTES - headBytes - markerBytes);
  return `${takeFirstUtf8Bytes(normalized, headBytes).trimEnd()}${marker}${takeLastUtf8Bytes(normalized, tailBytes).trimStart()}`;
}

function extractDialogueFromVideoDesc(videoDesc?: string | null) {
  const text = normalizeText(videoDesc);
  const match = text.match(/台词[：:]\s*(.*?)(?:音效[：:]|关联资产(?:ID)?[：:]|$)/);
  const dialogue = normalizeText(match?.[1] || "");
  if (!dialogue || /^无(?:台词|对白|配音)?[。.!！]?$/i.test(dialogue)) return "";
  return dialogue.replace(/[。；;]\s*$/, "");
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
  if (!missing.length) return normalizePromptWhitespace(prompt);
  return normalizePromptWhitespace([prompt, renderRequiredDialogueAppendix(missing)].filter(Boolean).join("\n\n"));
}

function limitCliproxyVideoPromptPreservingDialogue(prompt: string, requiredLines: string[]) {
  const normalized = ensureRequiredDialogueLines(prompt, requiredLines);
  if (getUtf8Bytes(normalized) <= CLIPROXY_VIDEO_PROMPT_MAX_BYTES) return normalized;

  const appendix = renderRequiredDialogueAppendix(requiredLines);
  if (appendix) {
    const separator = "\n\n";
    const reserveBytes = getUtf8Bytes(separator) + getUtf8Bytes(appendix);
    const bodyBudget = CLIPROXY_VIDEO_PROMPT_MAX_BYTES - reserveBytes;
    if (bodyBudget > 180) {
      return normalizePromptWhitespace(`${takeFirstUtf8Bytes(normalized, bodyBudget).trimEnd()}${separator}${appendix}`);
    }
  }

  return limitCliproxyVideoPrompt(normalized);
}

async function getUploadDataRequiredDialogueLines(uploadData: UploadItem[]) {
  const storyboardIds = uniqueText(
    uploadData
      .filter((item) => item.sources === "storyboard" && item.id != null)
      .map((item) => String(item.id)),
  ).map(Number);
  if (!storyboardIds.length) return [];
  const rows = await u.db("o_storyboard").whereIn("id", storyboardIds).select("videoDesc");
  return uniqueText(rows.map((row: any) => extractDialogueFromVideoDesc(row.videoDesc)).filter(Boolean));
}

async function getTrackRequiredDialogueLines(trackId: number) {
  const rows = await u.db("o_storyboard").where("trackId", trackId).orderBy("index", "asc").select("videoDesc");
  return uniqueText(rows.map((row: any) => extractDialogueFromVideoDesc(row.videoDesc)).filter(Boolean));
}

function hasRoleVoiceSetting(item: any) {
  return Boolean(normalizeText(item.voiceProfile) || normalizeText(item.voiceTone) || normalizeText(item.speechRate));
}

function mergeRoleVoiceSettings(target: Map<string, any>, rows: any[]) {
  rows
    .filter((item) => item?.type === "role" && hasRoleVoiceSetting(item))
    .forEach((item) => {
      const name = normalizeText(item.baseName || item.name);
      if (!name) return;
      const existing = target.get(name);
      target.set(name, {
        name,
        voiceProfile: normalizeText(existing?.voiceProfile) || normalizeText(item.voiceProfile) || null,
        voiceTone: normalizeText(existing?.voiceTone) || normalizeText(item.voiceTone) || null,
        speechRate: normalizeText(existing?.speechRate) || normalizeText(item.speechRate) || null,
      });
    });
}

async function buildUploadRoleVoiceAppendix(uploadData: UploadItem[]) {
  const roleVoiceMap = new Map<string, any>();
  for (const item of uploadData) {
    if (item.sources === "storyboard" && item.id) {
      mergeRoleVoiceSettings(roleVoiceMap, await resolveEffectiveStoryboardAssetReferences([Number(item.id)]));
    } else if (item.sources === "assets" && item.id) {
      mergeRoleVoiceSettings(roleVoiceMap, await resolveEffectiveAssetReferences([Number(item.id)]));
    }
  }
  const settings = Array.from(roleVoiceMap.values());
  if (!settings.length) return "";
  return [
    "",
    "[Character voice settings]",
    ...settings.map((item) => {
      const parts = [
        item.voiceProfile ? `voice: ${item.voiceProfile}` : "",
        item.voiceTone ? `tone: ${item.voiceTone}` : "",
        item.speechRate ? `speech rate: ${item.speechRate}` : "",
      ].filter(Boolean);
      return `${item.name}: ${parts.join("; ")}. Apply this to the character's Mandarin dialogue; do not render subtitles.`;
    }),
  ].join("\n");
}

async function getStoryboardVolcengineRoleUris(storyboardId?: number): Promise<string[]> {
  if (!storyboardId) return [];
  const rows = await u
    .db("o_assets2Storyboard")
    .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
    .leftJoin({ parentAsset: "o_assets" }, "o_assets.assetsId", "parentAsset.id")
    .where("o_assets2Storyboard.storyboardId", storyboardId)
    .orderBy("o_assets2Storyboard.rowid", "asc")
    .select("o_assets.type as assetsType", "o_assets.volcengineAssetUri", "parentAsset.volcengineAssetUri as parentVolcengineAssetUri");

  const seen = new Set<string>();
  return rows
    .filter((row: any) => row.assetsType === "role")
    .map((row: any) => normalizeVolcengineAssetUri(row.volcengineAssetUri || row.parentVolcengineAssetUri))
    .filter((uri: string | null): uri is string => {
      if (!uri || seen.has(uri)) return false;
      seen.add(uri);
      return true;
    });
}

function selectSingleStoryboardUploadData(uploadData: UploadItem[]): UploadItem[] {
  const validUploadData = uploadData.filter((item) => item?.id != null);
  const storyboardItem = validUploadData.find((item) => item.sources === "storyboard");
  const selected = storyboardItem ?? validUploadData[0];
  return selected ? [selected] : [];
}

function resolveEffectiveVideoModel(requestModel: string, projectModel?: string | null) {
  const requested = normalizeText(requestModel);
  const projectConfigured = normalizeText(projectModel);
  if (!requested) return projectConfigured;
  return requested;
}

async function getVideoModelDetail(model: string) {
  const [vendorId, modelName] = String(model || "").split(/:(.+)/);
  if (!vendorId || !modelName) return null;
  try {
    const models = await u.vendor.getModelList(vendorId);
    return models.find((item: any) => item.modelName === modelName) || null;
  } catch {
    return null;
  }
}

async function getOptionalTrackTailFrame(trackId: number, req: any) {
  try {
    return await ensureTrackSelectedVideoTailFrame(trackId, req);
  } catch (e) {
    const message = u.error(e).message;
    if (!/没有已完成的视频/.test(message)) {
      console.warn("[generateVideo] selected tail frame skipped:", { trackId, message });
    }
    return null;
  }
}

async function cacheVideoTailFrame(video: Parameters<typeof ensureVideoTailFrame>[0], req: any) {
  try {
    await ensureVideoTailFrame(video, req);
  } catch (e) {
    console.warn("[generateVideo] tail frame cache failed:", {
      videoId: video.id,
      projectId: video.projectId,
      message: u.error(e).message,
    });
  }
}

function appendSelectedTailFrameVideoInstruction(prompt: string, hasTailFrameReference: boolean) {
  if (!hasTailFrameReference) return prompt;
  if (/video tail frame reference|视频尾帧参考/i.test(prompt)) return prompt;
  return normalizePromptWhitespace(
    [
      prompt,
      "Video tail frame reference: if a selected reference image is a video tail frame, use it as a continuity still for character pose, scene layout, lighting, and motion transition. Do not show the reference as a collage, split screen, still board, or overlay.",
    ].join("\n"),
  );
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
        referenceImageKind: z.enum(["storyboard", "grid", "tailFrame"]).optional(),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    const projectData = await u.db("o_project").select("videoRatio", "videoModel").where("id", projectId).first();
    const effectiveModel = resolveEffectiveVideoModel(model, projectData?.videoModel);
    const modelDetail = await getVideoModelDetail(effectiveModel);
    const modelDisplayName = modelDetail?.name || modelDetail?.modelName || null;
    const durationRange = resolveVideoModelDurationRange(effectiveModel, modelDisplayName, modelDetail?.durationResolutionMap);
    const effectiveDuration = resolveVideoGenerationDuration(effectiveModel, duration, modelDisplayName, modelDetail?.durationResolutionMap);
    const [vendorId] = String(effectiveModel || "").split(/:(.+)/);
    const preferVolcengineAssetUri = vendorId === "volcengine" && isSeedance2VideoModel(effectiveModel, modelDisplayName);
    const preferPublicImageUrl = shouldUsePublicImageReferenceForVideoModel(effectiveModel);
    const minImageShortEdge = vendorId === "longxia" ? 320 : 0;
    const forceSingleImageReference = shouldForceSingleImageReferenceForVideoModel(effectiveModel, modelDisplayName);
    console.log(
      `[generateVideo] trackId=${trackId} requestModel=${model || "-"} projectModel=${projectData?.videoModel || "-"} effectiveModel=${effectiveModel || "-"} requestedDuration=${duration}s effectiveDuration=${effectiveDuration}s range=${formatVideoDurationRange(durationRange)}`,
    );
    let modeData: unknown = undefined;
    if (typeof mode === "string" && mode.trim().startsWith("[")) {
      try {
        const parsedMode = JSON.parse(mode);
        if (Array.isArray(parsedMode)) modeData = parsedMode;
      } catch {}
    }
    const effectiveMode = forceSingleImageReference ? "singleImage" : (modeData ?? mode);
    const effectiveUploadData = forceSingleImageReference ? selectSingleStoryboardUploadData(uploadData) : uploadData;
    const isSingleImageMode = effectiveMode === "singleImage" || (Array.isArray(effectiveMode) && effectiveMode.length === 1 && effectiveMode[0] === "singleImage");
    //获取生成视频比例
    const ratio = projectData;
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    //查询出图片数据
    const references = (
      await Promise.all(
      effectiveUploadData.map(async (item: EffectiveUploadItem) => {
        if (item.sources === "storyboard") {
          const roleAssetUris = preferVolcengineAssetUri && !isSingleImageMode ? await getStoryboardVolcengineRoleUris(item.id) : [];
          if (roleAssetUris.length) {
            return roleAssetUris.map((assetUri) => ({
              type: "image" as const,
              assetUri,
            }));
          }
          const storyboard = await u.db("o_storyboard").where("id", item.id).select("filePath", "gridImagePath", "trackId").first();
          const tailFrame = item.referenceImageKind === "tailFrame" && storyboard?.trackId
            ? await getOptionalTrackTailFrame(Number(storyboard.trackId), req)
            : null;
          const referencePath = item.referenceImageKind === "tailFrame"
            ? tailFrame?.filePath
            : item.referenceImageKind === "grid"
              ? storyboard?.gridImagePath
              : storyboard?.filePath;
          if (!referencePath) return null;
          return [{
            type: "image" as const,
            filePath: referencePath,
          }];
        }
        if (item.sources === "assets") {
          const assetId = Number(item.id);
          if (!Number.isInteger(assetId)) return null;
          const [assetData] = await resolveEffectiveAssetReferences([assetId]);
          const volcengineAssetUri = normalizeVolcengineAssetUri(assetData?.volcengineAssetUri || assetData?.parentVolcengineAssetUri);
          if (preferVolcengineAssetUri && assetData?.type === "role" && volcengineAssetUri) {
            return [{
              type: "image" as const,
              assetUri: volcengineAssetUri,
            }];
          }
          if (!assetData?.filePath) return null;
          const mediaType = inferReferenceMediaType(assetData.filePath, assetData.type);
          return [{
            type: mediaType,
            filePath: assetData.filePath,
          }];
        }
        return null;
      }),
      )
    ).flat();
    const seenAssetUris = new Set<string>();
    const dedupedReferences = references.filter((item) => {
      if (!item) return false;
      if ("assetUri" in item && item.assetUri) {
        if (seenAssetUris.has(item.assetUri)) return false;
        seenAssetUris.add(item.assetUri);
      }
      return true;
    });

    const referenceList = await Promise.all(
      dedupedReferences.map(async (item) => {
        if (!item) return null;
        if ("assetUri" in item && item.assetUri) {
          return {
            type: item.type,
            base64: item.assetUri,
          };
        }
        if (!("filePath" in item) || !item.filePath) return null;
        if (preferPublicImageUrl && item.type === "image") {
          return {
            type: item.type,
            base64: await getPublicOssFileUrl(item.filePath, req),
          };
        }
        return {
          type: item.type,
          base64: await filePathToDataUrl(item.filePath, item.type, { minImageShortEdge }),
        };
      }),
    );
    const roleVoiceAppendix = await buildUploadRoleVoiceAppendix(uploadData);
    const requiredDialogueLines = uniqueText([
      ...(await getTrackRequiredDialogueLines(trackId)),
      ...(await getUploadDataRequiredDialogueLines(uploadData)),
    ]);
    const hasTailFrameReference = (effectiveUploadData as UploadItem[]).some((item: UploadItem) => item.sources === "storyboard" && item.referenceImageKind === "tailFrame");
    const promptWithTailFrameAppendix = appendSelectedTailFrameVideoInstruction(prompt, hasTailFrameReference);
    const promptWithVoiceAppendix = roleVoiceAppendix && !String(promptWithTailFrameAppendix || "").includes("[Character voice settings]")
      ? `${promptWithTailFrameAppendix}\n${roleVoiceAppendix}`
      : promptWithTailFrameAppendix;
    const durationAlignedPrompt = isGrokImagineVideoModel(effectiveModel)
      ? enforceGrokTargetDurationPrompt(promptWithVoiceAppendix, effectiveDuration)
      : promptWithVoiceAppendix;
    const dialogueLanguageAlignedPrompt = ensureMandarinDialogueLanguageRule(durationAlignedPrompt, requiredDialogueLines);
    const finalPrompt =
      ["cliproxyapi", "dszyym"].includes(vendorId) && isGrokImagineVideoModel(effectiveModel, modelDisplayName)
        ? limitCliproxyVideoPromptPreservingDialogue(dialogueLanguageAlignedPrompt, requiredDialogueLines)
        : dialogueLanguageAlignedPrompt;
    if (finalPrompt !== prompt) {
      await u.db("o_videoTrack").where("id", trackId).update({ prompt: finalPrompt });
    }
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      localSaveState: "未保存",
      scriptId,
      projectId,
      videoTrackId: trackId,
      prompt: finalPrompt,
    });
    res.status(200).send(success({ id: videoId, prompt: finalPrompt }));
    (async () => {
      try {
        const relatedObjects = {
          projectId,
          videoId,
          scriptId,
          type: "视频",
        };
        const aiVideo = u.Ai.Video(effectiveModel as `${string}:${string}`);
        await aiVideo.run(
          {
            prompt: finalPrompt,
            referenceList: referenceList.filter((item): item is NonNullable<typeof item> => item !== null),
            mode: effectiveMode,
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
            describe: "根据提示词生成视频",
            relatedObjects: JSON.stringify(relatedObjects),
          },
        );
        const remoteUrl = aiVideo.getRemoteUrl();
        if (remoteUrl) {
          const remoteUrlExpireTime = Date.now() + REMOTE_VIDEO_URL_TTL_MS;
          await u.db("o_video").where("id", videoId).update({
            state: "已完成",
            remoteUrl,
            remoteUrlExpireTime,
            localSaveState: "保存中",
            localSaveErrorReason: "",
          });
          await cacheVideoTailFrame({
            id: videoId,
            projectId,
            scriptId,
            videoTrackId: trackId,
            filePath: videoPath,
            state: "已完成",
            remoteUrl,
            remoteUrlExpireTime,
          }, req);

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
        } else {
          await aiVideo.save(videoPath);
          await u.db("o_video").where("id", videoId).update({
            state: "已完成",
            localSaveState: "已保存",
            localSaveErrorReason: "",
          });
          await cacheVideoTailFrame({
            id: videoId,
            projectId,
            scriptId,
            videoTrackId: trackId,
            filePath: videoPath,
            state: "已完成",
          }, req);
        }
      } catch (error: any) {
        await u
          .db("o_video")
          .where("id", videoId)
          .update({
            state: "生成失败",
            errorReason: u.error(error).message,
          });
      }
    })();
  },
);
