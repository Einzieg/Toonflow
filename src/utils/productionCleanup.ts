import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { cleanupStoryboardFirstByProjectScript } from "@/utils/storyboardFirstCleanup";
import { cleanupStoryboardVideoReferenceFiles } from "@/utils/storyboardVideoReference";
import { getVideoTailFramePath } from "@/utils/videoTailFrame";

type CleanupOptions = {
  projectId: number;
  scriptId: number;
  clearAgentMemory?: boolean;
};

type CleanupResult = {
  agentWorkData: number;
  agentMemory: number;
  storyboards: number;
  storyboardBoards: number;
  storyboardFirstScripts: number;
  videoTracks: number;
  videos: number;
  derivedAssets: number;
  imageFlows: number;
};

function uniqueNumbers(values: unknown[]) {
  return Array.from(new Set(values.map(Number).filter((value) => Number.isInteger(value))));
}

async function deleteOssFileIfExists(filePath?: string | null) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    if (await u.oss.fileExists(normalized)) await u.oss.deleteFile(normalized);
  } catch (e) {
    console.warn("[production.cleanup] 清理文件失败:", normalized, u.error(e).message);
  }
}

async function deleteVideosByIds(videoIds: number[]) {
  const ids = uniqueNumbers(videoIds);
  if (!ids.length) return 0;

  const videos = await u.db("o_video").whereIn("id", ids);
  await Promise.all(
    videos.flatMap((video: any) => [
      deleteOssFileIfExists(video.filePath),
      Number.isInteger(Number(video.id)) && Number.isInteger(Number(video.projectId))
        ? deleteOssFileIfExists(getVideoTailFramePath(Number(video.id), Number(video.projectId)))
        : Promise.resolve(),
    ]),
  );
  await u.db("o_video").whereIn("id", ids).delete();
  return videos.length;
}

async function cleanupStoryboardBoards(projectId: number, scriptId: number) {
  const boards = await u.db("o_storyboardBoard").where({ projectId, scriptId });
  const boardIds = uniqueNumbers(boards.map((board: any) => board.id));
  if (!boardIds.length) return { boards: 0, videos: 0 };

  const boardVideos = await u.db("o_storyboardBoardVideo").whereIn("boardId", boardIds);
  const videoIds = uniqueNumbers(boardVideos.map((item: any) => item.videoId));
  const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
  const deletableVideoIds = uniqueNumbers(videos.filter((video: any) => video.videoTrackId == null).map((video: any) => video.id));

  await Promise.all(
    boards.flatMap((board: any) => [
      deleteOssFileIfExists(board.filePath),
      deleteOssFileIfExists(board.thumbPath),
      cleanupStoryboardVideoReferenceFiles({
        videoReferencePath: board.videoReferencePath,
        frameManifest: board.frameManifest,
      }),
    ]),
  );

  const deletedVideos = await deleteVideosByIds(deletableVideoIds);
  await u.db("o_storyboardBoardVideo").whereIn("boardId", boardIds).delete();
  await u.db("o_storyboardBoard").whereIn("id", boardIds).delete();
  return { boards: boards.length, videos: deletedVideos };
}

async function cleanupStoryboardPanel(projectId: number, scriptId: number) {
  const storyboards = await u.db("o_storyboard").where({ projectId, scriptId });
  const storyboardIds = uniqueNumbers(storyboards.map((storyboard: any) => storyboard.id));
  const storyboardTrackIds = uniqueNumbers(storyboards.map((storyboard: any) => storyboard.trackId));
  const storyboardFlowIds = uniqueNumbers(storyboards.map((storyboard: any) => storyboard.flowId));
  const allTrackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
  const trackIds = uniqueNumbers([...storyboardTrackIds, ...allTrackRows.map((track: any) => track.id)]);

  await Promise.all(
    storyboards.flatMap((storyboard: any) => [
      deleteOssFileIfExists(storyboard.filePath),
      deleteOssFileIfExists(storyboard.gridImagePath),
    ]),
  );

  let deletedVideos = 0;
  if (trackIds.length) {
    const videoRows = await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds);
    deletedVideos = await deleteVideosByIds(videoRows.map((video: any) => video.id));
  }

  if (storyboardIds.length) {
    await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).delete();
    await u.db("o_storyboard").whereIn("id", storyboardIds).delete();
  }
  if (trackIds.length) {
    await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).delete();
  }
  if (storyboardFlowIds.length) {
    await u.db("o_imageFlow").whereIn("id", storyboardFlowIds).delete();
  }

  return {
    storyboards: storyboards.length,
    videoTracks: trackIds.length,
    videos: deletedVideos,
    imageFlows: storyboardFlowIds.length,
  };
}

async function collectDescendantAssetIds(seedIds: number[]) {
  const all = new Set(seedIds);
  let frontier = [...seedIds];
  while (frontier.length) {
    const children = await u.db("o_assets").whereIn("assetsId", frontier).select("id");
    const next = uniqueNumbers(children.map((child: any) => child.id)).filter((id) => !all.has(id));
    next.forEach((id) => all.add(id));
    frontier = next;
  }
  return Array.from(all);
}

async function cleanupDerivedAssets(projectId: number, scriptId: number) {
  const scriptAssetRows = await u.db("o_scriptAssets").where({ scriptId }).select("assetId");
  const linkedAssetIds = uniqueNumbers(scriptAssetRows.map((item: any) => item.assetId));
  if (!linkedAssetIds.length) return { derivedAssets: 0, imageFlows: 0 };

  const directDerivedRows = await u
    .db("o_assets")
    .where({ projectId })
    .whereIn("id", linkedAssetIds)
    .whereNotNull("assetsId")
    .select("id");
  const directDerivedIds = uniqueNumbers(directDerivedRows.map((asset: any) => asset.id));
  if (!directDerivedIds.length) return { derivedAssets: 0, imageFlows: 0 };

  const assetIds = await collectDescendantAssetIds(directDerivedIds);
  const assets = await u.db("o_assets").where({ projectId }).whereIn("id", assetIds).select("id", "imageId", "flowId");
  const imageIds = uniqueNumbers(assets.map((asset: any) => asset.imageId));
  const flowIds = uniqueNumbers(assets.map((asset: any) => asset.flowId));
  const imageRowsById = imageIds.length ? await u.db("o_image").whereIn("id", imageIds) : [];
  const imageRowsByAsset = await u.db("o_image").whereIn("assetsId", assetIds);
  const imageRows = Array.from(new Map([...imageRowsById, ...imageRowsByAsset].map((image: any) => [Number(image.id), image])).values());
  const allImageIds = uniqueNumbers(imageRows.map((image: any) => image.id));

  await Promise.all(imageRows.map((image: any) => deleteOssFileIfExists(image.filePath)));
  await u.db("o_scriptAssets").where({ scriptId }).whereIn("assetId", assetIds).delete();
  await u.db("o_assets").where({ projectId }).whereIn("id", assetIds).delete();
  if (allImageIds.length) await u.db("o_image").whereIn("id", allImageIds).delete();
  if (flowIds.length) await u.db("o_imageFlow").whereIn("id", flowIds).delete();

  return { derivedAssets: assets.length, imageFlows: flowIds.length };
}

async function cleanupAgentState(projectId: number, scriptId: number, clearAgentMemory: boolean) {
  const workDataRows = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .where("key", "productionAgent")
    .where("episodesId", String(scriptId));
  await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .where("key", "productionAgent")
    .where("episodesId", String(scriptId))
    .delete();

  let memoryRows = 0;
  if (clearAgentMemory) {
    const isolationKey = `${projectId}:productionAgent:${scriptId}`;
    const rows = await u.db("memories").where({ isolationKey });
    memoryRows = rows.length;
    await u.db("memories").where({ isolationKey }).delete();
  }

  return { agentWorkData: workDataRows.length, agentMemory: memoryRows };
}

async function cleanupRemainingVideos(projectId: number, scriptId: number) {
  const videos = await u.db("o_video").where({ projectId, scriptId });
  return deleteVideosByIds(videos.map((video: any) => video.id));
}

export async function cleanupProductionEpisode(options: CleanupOptions): Promise<CleanupResult> {
  const projectId = Number(options.projectId);
  const scriptId = Number(options.scriptId);
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) {
    throw new Error("projectId/scriptId 必须是有效数字");
  }

  await u
    .db("o_storyboardFirstScript")
    .where({ projectId, scriptId, state: "生成中" })
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "任务已取消", updateTime: Date.now() });
  const firstScriptRows = await u.db("o_storyboardFirstScript").where({ projectId, scriptId }).select("id");
  await cleanupStoryboardFirstByProjectScript(projectId, scriptId);

  const boardResult = await cleanupStoryboardBoards(projectId, scriptId);
  const panelResult = await cleanupStoryboardPanel(projectId, scriptId);
  const derivedResult = await cleanupDerivedAssets(projectId, scriptId);
  const remainingVideos = await cleanupRemainingVideos(projectId, scriptId);
  const agentResult = await cleanupAgentState(projectId, scriptId, options.clearAgentMemory !== false);

  return {
    agentWorkData: agentResult.agentWorkData,
    agentMemory: agentResult.agentMemory,
    storyboards: panelResult.storyboards,
    storyboardBoards: boardResult.boards,
    storyboardFirstScripts: firstScriptRows.length,
    videoTracks: panelResult.videoTracks,
    videos: boardResult.videos + panelResult.videos + remainingVideos,
    derivedAssets: derivedResult.derivedAssets,
    imageFlows: panelResult.imageFlows + derivedResult.imageFlows,
  };
}
