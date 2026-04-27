import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { MAX_TRACK_DURATION_SECONDS, isFixedDurationSeedanceVideoModel, resolveVideoGenerationDuration } from "@/utils/storyboardTrack";
import path from "node:path";
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
}

type ReferenceMediaType = "image" | "video" | "audio";

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

async function filePathToDataUrl(filePath: string, mediaType: ReferenceMediaType): Promise<string> {
  const fileBuffer = await u.oss.getFile(filePath);
  const ext = path.extname(String(filePath || "").split("?")[0]).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || DEFAULT_MIME_BY_TYPE[mediaType];
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
}

function normalizeVolcengineAssetUri(value?: string | null): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.startsWith("asset://") ? normalized : `asset://${normalized}`;
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

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
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
    const effectiveDuration = resolveVideoGenerationDuration(model, duration);
    const preferVolcengineAssetUri = isFixedDurationSeedanceVideoModel(model);
    if (effectiveDuration > MAX_TRACK_DURATION_SECONDS) {
      return res.status(400).send(error(`当前轨道时长 ${effectiveDuration}s，超过可生成上限 ${MAX_TRACK_DURATION_SECONDS}s，请先重新拆分分镜轨道`));
    }
    let modeData: unknown = undefined;
    if (typeof mode === "string" && mode.trim().startsWith("[")) {
      try {
        const parsedMode = JSON.parse(mode);
        if (Array.isArray(parsedMode)) modeData = parsedMode;
      } catch {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    //查询出图片数据
    const references = (
      await Promise.all(
      uploadData.map(async (item: UploadItem) => {
        if (item.sources === "storyboard") {
          const roleAssetUris = preferVolcengineAssetUri ? await getStoryboardVolcengineRoleUris(item.id) : [];
          if (roleAssetUris.length) {
            return roleAssetUris.map((assetUri) => ({
              type: "image" as const,
              assetUri,
            }));
          }
          const storyboard = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
          if (!storyboard?.filePath) return null;
          return [{
            type: "image" as const,
            filePath: storyboard.filePath,
          }];
        }
        if (item.sources === "assets") {
          const assetData = await u
            .db("o_assets")
            .where("o_assets.id", item.id)
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .leftJoin({ parentAsset: "o_assets" }, "o_assets.assetsId", "parentAsset.id")
            .select(
              "o_image.filePath",
              "o_image.type as imageType",
              "o_assets.type as assetsType",
              "o_assets.volcengineAssetUri",
              "parentAsset.volcengineAssetUri as parentVolcengineAssetUri",
            )
            .first();
          const volcengineAssetUri = normalizeVolcengineAssetUri(assetData?.volcengineAssetUri || assetData?.parentVolcengineAssetUri);
          if (preferVolcengineAssetUri && assetData?.assetsType === "role" && volcengineAssetUri) {
            return [{
              type: "image" as const,
              assetUri: volcengineAssetUri,
            }];
          }
          if (!assetData?.filePath) return null;
          const mediaType = inferReferenceMediaType(assetData.filePath, assetData.imageType || assetData.assetsType);
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
        if (!item.filePath) return null;
        return {
          type: item.type,
          base64: await filePathToDataUrl(item.filePath, item.type),
        };
      }),
    );
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    res.status(200).send(success(videoId));
    (async () => {
      try {
        const relatedObjects = {
          projectId,
          videoId,
          scriptId,
          type: "视频",
        };
        const aiVideo = u.Ai.Video(model);
        await aiVideo.run(
          {
            prompt,
            referenceList: referenceList.filter((item): item is NonNullable<typeof item> => item !== null),
            mode: modeData ?? mode,
            duration: effectiveDuration,
            aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
            resolution,
            audio,
          },
          {
            projectId,
            taskClass: "视频生成",
            describe: "根据提示词生成视频",
            relatedObjects: JSON.stringify(relatedObjects),
          },
        );
        await aiVideo.save(videoPath);
        await u.db("o_video").where("id", videoId).update({ state: "已完成" });
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
