import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { MAX_TRACK_DURATION_SECONDS } from "@/utils/storyboardTrack";
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
    if (duration > MAX_TRACK_DURATION_SECONDS) {
      return res.status(400).send(error(`当前轨道时长 ${duration}s，超过可生成上限 ${MAX_TRACK_DURATION_SECONDS}s，请先重新拆分分镜轨道`));
    }
    let modeData: string[] = [];
    if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    //查询出图片数据
    const references = await Promise.all(
      uploadData.map(async (item: UploadItem) => {
        if (item.sources === "storyboard") {
          const storyboard = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
          if (!storyboard?.filePath) return null;
          return {
            type: "image" as const,
            filePath: storyboard.filePath,
          };
        }
        if (item.sources === "assets") {
          const assetData = await u
            .db("o_assets")
            .where("o_assets.id", item.id)
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type as imageType", "o_assets.type as assetsType")
            .first();
          if (!assetData?.filePath) return null;
          const mediaType = inferReferenceMediaType(assetData.filePath, assetData.imageType || assetData.assetsType);
          return {
            type: mediaType,
            filePath: assetData.filePath,
          };
        }
        return null;
      }),
    );

    const referenceList = await Promise.all(
      references.map(async (item) => {
        if (!item?.filePath) return null;
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
            mode: modeData.length > 0 ? modeData : mode,
            duration,
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
            errorReason: error instanceof Error ? error.message : "未知错误",
          });
      }
    })();
  },
);
