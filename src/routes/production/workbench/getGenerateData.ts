import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getRenderableVideoSrc, normalizeVideoState } from "@/utils/videoSource";
import { resolveEffectiveAssetReferences, resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { normalizeStoryboardShotMeta } from "@/utils/storyboardShotMeta";
import { getVideoTailFramePath } from "@/utils/videoTailFrame";
const router = express.Router();

function appendUrlVersion(url: string, version?: string | number | null) {
  if (!url || version == null || version === "") return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
}

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  errorReason?: string | null;
}

type ReferenceImageKind = "storyboard" | "grid" | "tailFrame";

interface TrackMedia {
  src: string;
  id?: number;
  fileType: "image" | "video" | "audio";
  sources?: "assets" | "storyboard";
  prompt?: string;
  duration?: number | string | null;
  videoDesc?: string;
  index?: number;
  shotMeta?: Record<string, any> | null;
  volcengineAssetUri?: string | null;
  referenceImageKind?: ReferenceImageKind;
  gridSrc?: string;
  gridImageState?: string | null;
  gridImageReason?: string | null;
  tailFrameSrc?: string;
  tailFrameVideoId?: number | null;
}

interface TrackItem {
  id?: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  duration?: number;
  selectVideoId?: number;
  referenceMediaLocked?: boolean;
  storyboardCount?: number;
  canUnmerge?: boolean;
  medias: TrackMedia[];
  videoList: VideoItem[];
}

type TrackReferenceOverride = {
  id: number;
  sources: "assets" | "storyboard";
  referenceImageKind?: ReferenceImageKind;
};

function parseShotMeta(
  value: unknown,
  input: { videoDesc?: string | null; duration?: number | string | null; sourceShotNo?: number | string | null } = {},
): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "object") return normalizeStoryboardShotMeta(value as Record<string, any>, input);
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? normalizeStoryboardShotMeta(parsed, input) : null;
  } catch {
    return null;
  }
}

function parseReferenceMediaOverride(value: unknown): TrackReferenceOverride[] | null {
  if (value == null || value === "") return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any): TrackReferenceOverride | null => {
        const sources = item?.sources === "assets" ? "assets" : item?.sources === "storyboard" ? "storyboard" : null;
        const id = Number(item?.id);
        if (!sources || !Number.isInteger(id) || id <= 0) return null;
        return {
          id,
          sources,
          referenceImageKind: sources === "storyboard" ? normalizeReferenceImageKind(item?.referenceImageKind) : undefined,
        };
      })
      .filter((item): item is TrackReferenceOverride => item != null)
      .filter((item): item is TrackReferenceOverride => Number.isInteger(item.id) && item.id > 0 && (item.sources === "assets" || item.sources === "storyboard"));
  } catch {
    return [];
  }
}

function normalizeReferenceImageKind(value: unknown): ReferenceImageKind {
  if (value === "grid" || value === "tailFrame") return value;
  return "storyboard";
}

function getStoryboardMediaSrc(i: any, referenceImageKind: ReferenceImageKind) {
  if (referenceImageKind === "grid") return i.gridSrc;
  if (referenceImageKind === "tailFrame") return i.tailFrameSrc;
  return i.filePath;
}

function buildStoryboardMedia(i: any, referenceImageKind: ReferenceImageKind = "storyboard"): TrackMedia {
  return {
    src: getStoryboardMediaSrc(i, referenceImageKind),
    fileType: "image",
    sources: "storyboard",
    ...(i.videoDesc != null ? { prompt: i.videoDesc } : {}),
    ...(i.id != null ? { id: i.id } : {}),
    duration: i.duration,
    shotMeta: parseShotMeta(i.shotMeta, {
      videoDesc: i.videoDesc,
      duration: i.duration,
      sourceShotNo: i.index != null ? Number(i.index) + 1 : null,
    }),
    index: i.index,
    referenceImageKind,
    gridSrc: i.gridSrc,
    gridImageState: i.gridImageState ?? "",
    gridImageReason: i.gridImageReason ?? "",
    tailFrameSrc: i.tailFrameSrc ?? "",
    tailFrameVideoId: i.tailFrameVideoId ?? null,
  } as TrackMedia;
}

function selectTrackCompletedVideo(track: any, videoList: any[]) {
  const preferredId = Number(track?.videoId || track?.selectVideoId || 0);
  const completedVideos = videoList
    .filter((video) => Number(video.videoTrackId) === Number(track?.id) && normalizeVideoState(video.state) === "已完成")
    .sort((a, b) => Number(b.time || 0) - Number(a.time || 0));
  if (Number.isInteger(preferredId) && preferredId > 0) {
    const selected = completedVideos.find((video) => Number(video.id) === preferredId);
    if (selected) return selected;
  }
  return completedVideos[0] ?? null;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const projectData = await u.db("o_project").where("id", projectId).select("id", "videoModel", "mode").first();

    if (!projectData?.videoModel) {
      return res.status(400).json(success("项目未配置视频模型"));
    }
    let videoMode = "";
    try {
      videoMode = JSON.parse(projectData?.mode ?? "");
    } catch (e) {
      videoMode = projectData?.mode ?? "";
    }
    const isRef = Array.isArray(videoMode) ? true : false;

    const storyboardList: any[] = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    await Promise.all(
      storyboardList.map(async (i) => {
        i.filePath = i.filePath ? appendUrlVersion(await u.oss.getSmallImageUrl(i.filePath), i.flowId ?? i.id) : "";
        i.gridSrc = i.gridImagePath ? appendUrlVersion(await u.oss.getSmallImageUrl(i.gridImagePath), i.gridImageFlowId ?? i.id) : "";
      }),
    );
    const activeTrackIds = [...new Set(storyboardList.map((item) => item.trackId).filter((trackId): trackId is number => trackId != null))];
    // 按 storyboardId 分组的资产数据，key 为 storyboardId
    const otherDataMap: Record<number, any[]> = {};
    if (isRef) {
      const storyIds = storyboardList.map((s) => s.id);
      const assetDatas = await resolveEffectiveStoryboardAssetReferences(storyIds as number[]);

      await Promise.all(
        assetDatas.map(async (i) => {
          const item = {
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            fileType: "image" as const,
            sources: "assets",
            src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
            volcengineAssetUri: i.volcengineAssetUri || i.parentVolcengineAssetUri || null,
          };
          const sid = i.storyboardId as number;
          if (!otherDataMap[sid]) otherDataMap[sid] = [];
          otherDataMap[sid].push(item);
        }),
      );
    }

    const trackData = activeTrackIds.length ? await u.db("o_videoTrack").whereIn("id", activeTrackIds) : [];
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      trackData.map((t) => t.id),
    );
    const selectedVideoByTrackId = new Map<number, any>();
    trackData.forEach((track) => {
      const selectedVideo = selectTrackCompletedVideo(track, videoList);
      if (selectedVideo?.id) selectedVideoByTrackId.set(Number(track.id), selectedVideo);
    });
    await Promise.all(
      storyboardList.map(async (i) => {
        const selectedVideo = i.trackId != null ? selectedVideoByTrackId.get(Number(i.trackId)) : null;
        const tailFramePath = selectedVideo?.id ? getVideoTailFramePath(Number(selectedVideo.id), projectId) : "";
        if (tailFramePath && (await u.oss.fileExists(tailFramePath))) {
          i.tailFrameSrc = appendUrlVersion(await u.oss.getSmallImageUrl(tailFramePath), selectedVideo.id);
          i.tailFrameVideoId = Number(selectedVideo.id);
        } else {
          i.tailFrameSrc = "";
          i.tailFrameVideoId = null;
        }
      }),
    );
    const storyboardTrackRecord: Record<number, any[]> = {};
    storyboardList.forEach((i) => {
      if (storyboardTrackRecord[i.trackId!]) {
        storyboardTrackRecord[i.trackId!].push(buildStoryboardMedia(i));
      } else {
        storyboardTrackRecord[i.trackId!] = [buildStoryboardMedia(i)];
      }
    });
    const referenceOverrideByTrackId = new Map<number, TrackReferenceOverride[] | null>();
    const overrideAssetIds = new Set<number>();
    trackData.forEach((track) => {
      const parsed = parseReferenceMediaOverride(track.referenceMediaOverride);
      referenceOverrideByTrackId.set(Number(track.id), parsed);
      parsed?.forEach((item) => {
        if (item.sources === "assets") overrideAssetIds.add(item.id);
      });
    });
    const overrideAssetRows = overrideAssetIds.size ? await resolveEffectiveAssetReferences([...overrideAssetIds]) : [];
    const overrideAssetMediaMap = new Map<number, TrackMedia>();
    await Promise.all(
      overrideAssetRows.map(async (i: any) => {
        overrideAssetMediaMap.set(i.id, {
          id: i.id,
          name: i.name,
          describe: i.describe,
          type: i.type,
          fileType: "image",
          sources: "assets",
          src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          volcengineAssetUri: i.volcengineAssetUri || i.parentVolcengineAssetUri || null,
          voiceProfile: i.voiceProfile,
          voiceTone: i.voiceTone,
          speechRate: i.speechRate,
        } as TrackMedia);
      }),
    );
    const storyboardById = new Map<number, any>(storyboardList.map((item) => [Number(item.id), item]));
    const trackList: TrackItem[] = [];
    const trackIdMap = activeTrackIds.filter((trackId) => trackData.some((t) => Number(t.id) === Number(trackId)));
    for (const trackId of trackIdMap) {
      const item = trackData.find((t) => t.id === trackId);
      const storyboardCount = storyboardTrackRecord[trackId]?.length ?? 0;
      const referenceOverride = referenceOverrideByTrackId.get(trackId);
      const referenceMediaLocked = referenceOverride != null;
      const defaultMedias = (() => {
        const storyboardMedias = storyboardTrackRecord[trackId] ?? [];
        const assetMedias = storyboardMedias.flatMap((s) => otherDataMap[s.id] ?? []);
        const seenAssetIds = new Set<number>();
        const uniqueAssets = assetMedias.filter((a) => {
          if (seenAssetIds.has(a.id)) return false;
          seenAssetIds.add(a.id);
          return true;
        });
        const hasImageAssetData = uniqueAssets.filter((i) => i.src || i.volcengineAssetUri);
        const notHasImageAssetData = uniqueAssets.filter((i) => !i.src && !i.volcengineAssetUri);

        return [...hasImageAssetData, ...storyboardMedias, ...notHasImageAssetData];
      })();
      const overrideMedias =
        referenceOverride?.flatMap((ref) => {
          if (ref.sources === "storyboard") {
            const storyboard = storyboardById.get(ref.id);
            return storyboard ? [buildStoryboardMedia(storyboard, normalizeReferenceImageKind(ref.referenceImageKind))] : [];
          }
          const asset = overrideAssetMediaMap.get(ref.id);
          return asset ? [asset] : [];
        }) ?? [];
      trackList.push({
        id: trackId,
        duration: item?.duration ?? 0,
        prompt: item?.prompt || "",
        state: normalizeVideoState(item?.state) as "未生成" | "生成中" | "已完成" | "生成失败",
        reason: item?.reason ?? "",
        selectVideoId: Number(item?.videoId)!,
        referenceMediaLocked,
        storyboardCount,
        canUnmerge: storyboardCount > 1,
        medias: referenceMediaLocked ? overrideMedias : defaultMedias,
        videoList: await Promise.all(
          videoList
            .filter((v) => v.videoTrackId === trackId)
            .map(async (v) => ({
              id: v.id!,
              src: await getRenderableVideoSrc(v),
              state: normalizeVideoState(v.state),
              errorReason: v.errorReason ?? "",
            })),
        ),
      });
    }
    res.status(200).send(
      success({
        storyboardList: await Promise.all(
          storyboardList.map(async (s) => ({
            ...s,
            shotMeta: parseShotMeta(s.shotMeta, {
              videoDesc: s.videoDesc,
              duration: s.duration,
              sourceShotNo: s.index != null ? Number(s.index) + 1 : null,
            }),
            src: s.filePath,
          })),
        ),
        trackList,
      }),
    );
  },
);
