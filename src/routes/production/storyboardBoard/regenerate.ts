import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { STORYBOARD_BOARD_FIXED_IMAGE_RATIO, generateStoryboardBoardImageFromScript, type StoryboardBoardContext, type StoryboardBoardInput } from "@/utils/storyboardBoard";

const router = express.Router();

function normalizeImageQuality(value: unknown): StoryboardBoardContext["imageQuality"] {
  const text = String(value || "");
  return text === "1K" || text === "2K" || text === "4K" ? text : null;
}

function normalizeVideoRatio(value: unknown): StoryboardBoardContext["videoRatio"] {
  const text = String(value || "");
  return text === "16:9" || text === "9:16" ? text : null;
}

function parseStoryboardIds(value?: string | null): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

async function deleteOssFileIfExists(filePath?: string | null) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    if (await u.oss.fileExists(normalized)) await u.oss.deleteFile(normalized);
  } catch (e) {
    console.warn("[storyboardBoard.regenerate] 清理文件失败:", normalized, u.error(e).message);
  }
}

async function buildImageUrls(row: any) {
  const imageUrl = row.filePath ? await u.oss.getFileUrl(row.filePath) : "";
  const thumbUrl = row.thumbPath ? await u.oss.getFileUrl(row.thumbPath) : imageUrl ? u.oss.buildImagePreviewUrl(imageUrl, { width: 640, format: "webp" }) : "";
  return { imageUrl, thumbUrl };
}

async function formatBoard(row: any) {
  return {
    ...row,
    storyboardIds: parseStoryboardIds(row.storyboardIds),
    ...(await buildImageUrls(row)),
  };
}

async function deleteStaleBoardVideos(boardId: number) {
  const boardVideos = await u.db("o_storyboardBoardVideo").where("boardId", boardId);
  const videoIds = boardVideos.map((item: any) => Number(item.videoId)).filter((id) => Number.isInteger(id));
  const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
  const deletableVideos = videos.filter((item: any) => item.videoTrackId == null);
  await Promise.all(deletableVideos.map((item: any) => deleteOssFileIfExists(item.filePath)));
  await u.db("o_storyboardBoardVideo").where("boardId", boardId).delete();
  if (deletableVideos.length) {
    await u
      .db("o_video")
      .whereIn(
        "id",
        deletableVideos.map((item: any) => item.id),
      )
      .delete();
  }
}

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
  }),
  async (req, res) => {
    const { boardId } = req.body as { boardId: number };
    const board = await u.db("o_storyboardBoard").where("id", boardId).first();
    if (!board) return res.status(404).send(error("故事板不存在"));
    if (board.state === "生成中") return res.status(400).send(error("故事板正在生成中，请稍后再试"));

    const projectId = Number(board.projectId);
    const scriptId = Number(board.scriptId);
    if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) return res.status(400).send(error("故事板缺少项目或剧集信息"));

    const storyboardIds = parseStoryboardIds(board.storyboardIds);
    if (!storyboardIds.length) return res.status(400).send(error("故事板缺少关联分镜"));

    const [project, script, storyboards] = await Promise.all([
      u.db("o_project").where("id", projectId).select("name", "type", "imageModel", "imageQuality", "videoRatio", "artStyle", "directorManual").first(),
      u.db("o_script").where({ id: scriptId, projectId }).select("name", "content").first(),
      u
        .db("o_storyboard")
        .where({ projectId, scriptId })
        .whereIn("id", storyboardIds)
        .orderBy("index", "asc")
        .select("id", "index", "filePath", "duration", "prompt", "videoDesc", "track"),
    ]);

    if (!script) return res.status(400).send(error("剧集不存在或不属于当前项目"));
    if (!project?.imageModel) return res.status(400).send(error("项目未配置图片生成模型"));
    if (storyboards.length !== storyboardIds.length) return res.status(400).send(error("故事板关联分镜不完整"));

    await deleteStaleBoardVideos(boardId);
    await u.db("o_storyboardBoard").where("id", boardId).update({
      filePath: "",
      thumbPath: "",
      state: "生成中",
      errorReason: "",
      updateTime: Date.now(),
    });
    const runningBoard = await u.db("o_storyboardBoard").where("id", boardId).first();
    res.status(200).send(success(await formatBoard(runningBoard)));

    void (async () => {
      const oldFilePath = board.filePath;
      const oldThumbPath = board.thumbPath;
      try {
        const context: StoryboardBoardContext = {
          projectId,
          scriptId,
          scriptContent: script.content,
          projectName: project.name,
          projectType: project.type,
          imageModel: String(project.imageModel),
          imageQuality: normalizeImageQuality(project.imageQuality),
          videoRatio: normalizeVideoRatio(project.videoRatio),
          artStyle: project.artStyle,
          directorManual: project.directorManual,
          ratio: STORYBOARD_BOARD_FIXED_IMAGE_RATIO,
          itemsPerBoard: storyboards.length,
          targetDuration: Number(board.targetDuration) || undefined,
        };
        const image = await generateStoryboardBoardImageFromScript(storyboards as StoryboardBoardInput[], context, { shotScript: board.shotScript });
        await u.db("o_storyboardBoard").where("id", boardId).update({
          filePath: image.filePath,
          thumbPath: image.thumbPath,
          shotScript: image.shotScript,
          imagePrompt: image.imagePrompt,
          imageModel: image.imageModel,
          targetDuration: image.targetDuration,
          sourceHash: image.sourceHash,
          ratio: STORYBOARD_BOARD_FIXED_IMAGE_RATIO,
          state: "已完成",
          errorReason: "",
          updateTime: Date.now(),
        });
        await deleteOssFileIfExists(oldFilePath);
        await deleteOssFileIfExists(oldThumbPath);
      } catch (e) {
        await u.db("o_storyboardBoard").where("id", boardId).update({
          state: "生成失败",
          errorReason: u.error(e).message,
          updateTime: Date.now(),
        });
      }
    })();
  },
);
