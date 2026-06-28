import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getVideoTailFramePath } from "@/utils/videoTailFrame";
import { normalizeVideoState } from "@/utils/videoSource";
const router = express.Router();

type ReferenceImageKind = "storyboard" | "grid" | "tailFrame";

function appendUrlVersion(url: string, version?: string | number | null) {
    if (!url || version == null || version === "") return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
}

export default router.post(
    "/",
    validateFields({
        items: z.array(z.object({
            id: z.number(),
            sources: z.string(),
            referenceImageKind: z.enum(["storyboard", "grid", "tailFrame"]).optional(),
        }))
    }),
    async (req, res) => {
        const { items } = req.body;
        const result: Record<string, string> = {};
        const storyboardItems: Array<{ id: number; referenceImageKind: ReferenceImageKind }> = items
            .filter((item: any) => item.sources == "storyboard")
            .map((item: any) => ({
                id: Number(item.id),
                referenceImageKind: item.referenceImageKind === "grid" || item.referenceImageKind === "tailFrame" ? item.referenceImageKind : "storyboard",
            }));
        const storyboardIds: number[] = [...new Set(storyboardItems.map((item) => item.id))]
        const totalFilePaths: Array<{ id: number | string; filePath?: string | null; sources: string; referenceImageKind?: string; version?: string | number | null }> = []
        if (storyboardIds.length) {
            const storyBoardPaths = await u.db("o_storyboard").whereIn("id", storyboardIds).select("id", "projectId", "trackId", "filePath", "flowId", "gridImagePath", "gridImageFlowId");
            const storyBoardPathMap = new Map(storyBoardPaths.map((item: any) => [Number(item.id), item]));
            const tailFrameTrackIds = [
                ...new Set(
                    storyBoardPaths
                        .filter((item: any) => item.trackId != null)
                        .map((item: any) => Number(item.trackId))
                        .filter((id: number) => Number.isInteger(id) && id > 0),
                ),
            ];
            const trackRows = tailFrameTrackIds.length
                ? await u.db("o_videoTrack").whereIn("id", tailFrameTrackIds).select("id", "videoId", "selectVideoId")
                : [];
            const videoRows = tailFrameTrackIds.length ? await u.db("o_video").whereIn("videoTrackId", tailFrameTrackIds) : [];
            const selectedVideoByTrackId = new Map<number, any>();
            trackRows.forEach((track: any) => {
                const preferredId = Number(track.videoId || track.selectVideoId || 0);
                const completedVideos = videoRows
                    .filter((video: any) => Number(video.videoTrackId) === Number(track.id) && normalizeVideoState(video.state) === "已完成")
                    .sort((a: any, b: any) => Number(b.time || 0) - Number(a.time || 0));
                const selectedVideo = Number.isInteger(preferredId) && preferredId > 0
                    ? completedVideos.find((video: any) => Number(video.id) === preferredId) || completedVideos[0]
                    : completedVideos[0];
                if (selectedVideo?.id) selectedVideoByTrackId.set(Number(track.id), selectedVideo);
            });
            const storyboardFileItems = await Promise.all(
                storyboardItems.map(async (requestItem: { id: number; referenceImageKind: ReferenceImageKind }) => {
                    const i = storyBoardPathMap.get(requestItem.id);
                    const referenceImageKind = requestItem.referenceImageKind;
                    if (!i) {
                        return {
                            id: requestItem.id,
                            filePath: "",
                            sources: "storyboard",
                            referenceImageKind,
                            version: "",
                        };
                    }
                    if (referenceImageKind === "tailFrame") {
                        const selectedVideo = i.trackId != null ? selectedVideoByTrackId.get(Number(i.trackId)) : null;
                        const tailFramePath = selectedVideo?.id ? getVideoTailFramePath(Number(selectedVideo.id), Number(i.projectId)) : "";
                        const filePath = tailFramePath && await u.oss.fileExists(tailFramePath) ? tailFramePath : "";
                        return {
                            id: requestItem.id,
                            filePath,
                            sources: "storyboard",
                            referenceImageKind,
                            version: selectedVideo?.id ?? "",
                        };
                    }
                    return {
                        id: requestItem.id,
                        filePath: referenceImageKind === "grid" ? i.gridImagePath : i.filePath,
                        sources: "storyboard",
                        referenceImageKind,
                        version: referenceImageKind === "grid" ? (i.gridImageFlowId ?? i.id) : (i.flowId ?? i.id),
                    };
                }),
            );
            totalFilePaths.push(
                ...storyboardFileItems
            )
        }
        const assetsIds = items.filter((item: any) => item.sources == "assets").map((item: any) => item.id)
        if (assetsIds.length) {
            const assetsPaths = await u.db("o_assets").leftJoin("o_image", "o_image.id", "o_assets.imageId").whereIn("o_assets.id", assetsIds).select("o_assets.id", "o_image.filePath");
            totalFilePaths.push(...assetsPaths.map(i => ({ id: i.id, filePath: i.filePath, sources: "assets" })))
        }

        await Promise.all(
            totalFilePaths.map(async (item) => {
                const url = item.filePath ? await u.oss.getFileUrl(item.filePath) : "";
                const key = item.sources === "storyboard" ? `${item.id}:${item.sources}:${item.referenceImageKind || "storyboard"}` : `${item.id}:${item.sources}`;
                result[key] = item.sources === "storyboard" ? appendUrlVersion(url, item.version) : url;
            }))

        res.status(200).send(success({ data: result }));
    },
);
