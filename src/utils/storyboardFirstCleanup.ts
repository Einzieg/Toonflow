import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { cleanupStoryboardVideoReferenceFiles } from "@/utils/storyboardVideoReference";

async function deleteOssFileIfExists(filePath?: string | null) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    if (await u.oss.fileExists(normalized)) await u.oss.deleteFile(normalized);
  } catch (e) {
    console.warn("[storyboardFirst.cleanup] 清理文件失败:", normalized, u.error(e).message);
  }
}

export async function cleanupStoryboardFirstVideosByImageIds(firstImageIds: number[]) {
  const imageIds = firstImageIds.filter((id) => Number.isInteger(id));
  if (!imageIds.length) return;

  await u
    .db("o_storyboardFirstVideo")
    .whereIn("firstImageId", imageIds)
    .where("state", "生成中")
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "任务已取消", updateTime: Date.now() });

  const rows = await u.db("o_storyboardFirstVideo").whereIn("firstImageId", imageIds);
  const videoIds = rows.map((item: any) => Number(item.videoId)).filter((id: number) => Number.isInteger(id));
  const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds).whereNull("videoTrackId") : [];

  await Promise.all(videos.map((video: any) => deleteOssFileIfExists(video.filePath)));
  await u.db("o_storyboardFirstVideo").whereIn("firstImageId", imageIds).delete();
  if (videos.length) {
    await u
      .db("o_video")
      .whereIn(
        "id",
        videos.map((video: any) => video.id),
      )
      .whereNull("videoTrackId")
      .delete();
  }
}

export async function cleanupStoryboardFirstImagesByIds(firstImageIds: number[]) {
  const imageIds = firstImageIds.filter((id) => Number.isInteger(id));
  if (!imageIds.length) return;

  await u
    .db("o_storyboardFirstImage")
    .whereIn("id", imageIds)
    .where("state", "生成中")
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "任务已取消", updateTime: Date.now() });

  const images = await u.db("o_storyboardFirstImage").whereIn("id", imageIds);
  await cleanupStoryboardFirstVideosByImageIds(imageIds);
  await Promise.all(
    images.flatMap((image: any) => [
      deleteOssFileIfExists(image.filePath),
      deleteOssFileIfExists(image.thumbPath),
      cleanupStoryboardVideoReferenceFiles({
        videoReferencePath: image.videoReferencePath,
        frameManifest: image.frameManifest,
      }),
    ]),
  );
  await u.db("o_storyboardFirstImage").whereIn("id", imageIds).delete();
}

export async function cleanupStoryboardFirstScriptsByIds(firstScriptIds: number[]) {
  const scriptIds = firstScriptIds.filter((id) => Number.isInteger(id));
  if (!scriptIds.length) return;

  await u
    .db("o_storyboardFirstScript")
    .whereIn("id", scriptIds)
    .where("state", "生成中")
    .update({ state: "已取消", jobToken: uuidv4(), errorReason: "任务已取消", updateTime: Date.now() });

  const images = await u.db("o_storyboardFirstImage").whereIn("firstScriptId", scriptIds).select("id");
  await cleanupStoryboardFirstImagesByIds(images.map((image: any) => Number(image.id)));
  await u.db("o_storyboardFirstScript").whereIn("id", scriptIds).delete();
}

export async function cleanupStoryboardFirstByProjectScript(projectId: number, scriptId: number) {
  const scripts = await u.db("o_storyboardFirstScript").where({ projectId, scriptId }).select("id");
  await cleanupStoryboardFirstScriptsByIds(scripts.map((script: any) => Number(script.id)));
}

export async function cleanupStoryboardFirstByProject(projectId: number) {
  const scripts = await u.db("o_storyboardFirstScript").where({ projectId }).select("id");
  await cleanupStoryboardFirstScriptsByIds(scripts.map((script: any) => Number(script.id)));
}
