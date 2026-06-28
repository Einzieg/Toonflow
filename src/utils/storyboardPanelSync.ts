import u from "@/utils";
import {
  getPlannedStoryboardTrackStorageValue,
  normalizeStoryboardTrack,
  planStoryboardTrackSegments,
  resolveStoryboardTrackTargetDuration,
  STORYBOARD_AUTO_TRACK_KEY,
} from "@/utils/storyboardTrack";

async function getProjectVideoModelDetail(projectData: any) {
  const [vendorId, modelName] = String(projectData?.videoModel || "").split(/:(.+)/);
  if (!vendorId || !modelName) return null;
  try {
    const models = await u.vendor.getModelList(vendorId);
    return models.find((item: any) => item.modelName === modelName) ?? null;
  } catch {
    return null;
  }
}

function needsTrackSync(row: any) {
  return row.trackId == null || !Number.isInteger(Number(row.trackId)) || String(row.track ?? "").trim() === "__AUTO__";
}

export async function ensureStoryboardTracks(projectId: number, scriptId: number) {
  const [storyboardRows, projectData, existingTrackRows] = await Promise.all([
    u
      .db("o_storyboard")
      .where({ projectId, scriptId })
      .orderBy("index", "asc")
      .select("id", "index", "track", "trackId", "duration", "videoDesc"),
    u.db("o_project").where("id", projectId).select("videoModel").first(),
    u.db("o_videoTrack").where({ projectId, scriptId }).select("id"),
  ]);

  if (!storyboardRows.length) {
    return { synced: false, storyboardCount: 0, trackCount: existingTrackRows.length };
  }
  const hasAutoMergedExistingTrack = storyboardRows.some((row: any, index: number) => {
    const previous = storyboardRows[index - 1];
    if (!previous || row.trackId == null || previous.trackId == null || Number(row.trackId) !== Number(previous.trackId)) return false;
    return normalizeStoryboardTrack(row.track) === STORYBOARD_AUTO_TRACK_KEY && normalizeStoryboardTrack(previous.track) === STORYBOARD_AUTO_TRACK_KEY;
  });
  if (!storyboardRows.some(needsTrackSync) && !hasAutoMergedExistingTrack && existingTrackRows.length > 0) {
    return { synced: false, storyboardCount: storyboardRows.length, trackCount: existingTrackRows.length };
  }

  const modelDetail = await getProjectVideoModelDetail(projectData);
  const trackTargetDuration = resolveStoryboardTrackTargetDuration(
    projectData?.videoModel,
    modelDetail?.name || modelDetail?.modelName,
    modelDetail?.durationResolutionMap,
  );
  const plannedSegments = planStoryboardTrackSegments(storyboardRows, trackTargetDuration);
  const reusedTrackIds = new Set<number>();
  const originalStoryboardIdsByTrackId = new Map<number, Set<number>>();
  storyboardRows.forEach((row: any) => {
    const trackId = Number(row.trackId);
    const storyboardId = Number(row.id);
    if (!Number.isInteger(trackId) || !Number.isInteger(storyboardId)) return;
    const storyboardIds = originalStoryboardIdsByTrackId.get(trackId) ?? new Set<number>();
    storyboardIds.add(storyboardId);
    originalStoryboardIdsByTrackId.set(trackId, storyboardIds);
  });

  for (const segment of plannedSegments) {
    const storyboardIds = segment.items.map((item) => item.id).filter((id): id is number => id != null);
    if (!storyboardIds.length) continue;
    const trackStorageValue = getPlannedStoryboardTrackStorageValue(segment);

    const candidateTrackId =
      segment.items
        .map((item) => item.trackId)
        .find((trackId): trackId is number => trackId != null && !reusedTrackIds.has(trackId)) ?? null;

    let trackId = candidateTrackId;
    if (trackId == null) {
      const [newTrackId] = await u.db("o_videoTrack").insert({
        scriptId,
        projectId,
        duration: segment.duration,
      });
      trackId = newTrackId;
    } else {
      const originalStoryboardIds = originalStoryboardIdsByTrackId.get(trackId);
      const segmentStoryboardIdSet = new Set(storyboardIds.map(Number));
      const trackMembershipChanged =
        originalStoryboardIds != null &&
        (originalStoryboardIds.size !== segmentStoryboardIdSet.size || [...originalStoryboardIds].some((id) => !segmentStoryboardIdSet.has(id)));
      const membershipChanged = trackMembershipChanged || segment.items.some((item) => item.trackId !== trackId || String(item.track ?? "") !== trackStorageValue);
      await u
        .db("o_videoTrack")
        .where("id", trackId)
        .update({
          duration: segment.duration,
          ...(membershipChanged
            ? {
                prompt: "",
                reason: null,
                state: null,
                videoId: null,
                selectVideoId: null,
              }
            : {}),
        });
    }

    reusedTrackIds.add(trackId);
    await u.db("o_storyboard").whereIn("id", storyboardIds).update({
      trackId,
      track: trackStorageValue,
    });
  }

  const staleTrackIds = existingTrackRows
    .map((item: any) => Number(item.id))
    .filter((id) => Number.isInteger(id) && !reusedTrackIds.has(id));
  if (staleTrackIds.length) {
    const trackIdsWithVideos = new Set(
      (await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", staleTrackIds).select("videoTrackId")).map((item: any) =>
        Number(item.videoTrackId),
      ),
    );
    const emptyStaleTrackIds = staleTrackIds.filter((trackId) => !trackIdsWithVideos.has(trackId));
    if (emptyStaleTrackIds.length) {
      await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", emptyStaleTrackIds).del();
    }
  }

  return { synced: true, storyboardCount: storyboardRows.length, trackCount: plannedSegments.length };
}
