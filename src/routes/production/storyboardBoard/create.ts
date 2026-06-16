import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  STORYBOARD_BOARD_FIXED_IMAGE_RATIO,
  computeStoryboardBoardSourceHash,
  generateStoryboardBoardImageFromScript,
  planStoryboardBoardSegments,
  type StoryboardBoardContext,
  type StoryboardBoardInput,
  type StoryboardBoardLayout,
  type StoryboardBoardRatio,
} from "@/utils/storyboardBoard";
import { normalizeStoryboardDuration } from "@/utils/storyboardTrack";

const router = express.Router();

function normalizeIds(ids: number[]) {
  return Array.from(new Set(ids.filter((id) => Number.isInteger(id))));
}

function normalizeImageQuality(value: unknown): StoryboardBoardContext["imageQuality"] {
  const text = String(value || "");
  return text === "1K" || text === "2K" || text === "4K" ? text : null;
}

function normalizeVideoRatio(value: unknown): StoryboardBoardContext["videoRatio"] {
  const text = String(value || "");
  return text === "16:9" || text === "9:16" ? text : null;
}

function safeParseStoryboardIds(value?: string | null) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoryboardIds(value?: string | null): number[] {
  return safeParseStoryboardIds(value).map((item: unknown) => Number(item)).filter((id: number) => Number.isInteger(id));
}

function resolveTargetDuration(storyboards: StoryboardBoardInput[], value?: number | null) {
  const explicit = Number(value);
  if (Number.isFinite(explicit) && explicit > 0) return Number(explicit.toFixed(3));
  const total = storyboards.reduce((sum, item) => sum + normalizeStoryboardDuration(item.duration), 0);
  return Number(Math.max(1, total || 6).toFixed(3));
}

async function deleteOssFileIfExists(filePath?: string | null) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return;
  try {
    if (await u.oss.fileExists(normalized)) await u.oss.deleteFile(normalized);
  } catch (e) {
    console.warn("[storyboardBoard.create] 清理旧文件失败:", normalized, u.error(e).message);
  }
}

async function deleteBoardVideos(boardIds: number[]) {
  if (!boardIds.length) return;
  const boardVideos = await u.db("o_storyboardBoardVideo").whereIn("boardId", boardIds);
  const videoIds = boardVideos.map((item: any) => Number(item.videoId)).filter((id) => Number.isInteger(id));
  const videos = videoIds.length ? await u.db("o_video").whereIn("id", videoIds) : [];
  const deletableVideos = videos.filter((item: any) => item.videoTrackId == null);
  await Promise.all(deletableVideos.map((item: any) => deleteOssFileIfExists(item.filePath)));
  await u.db("o_storyboardBoardVideo").whereIn("boardId", boardIds).delete();
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

async function replaceOverlappingBoards(projectId: number, scriptId: number, storyboardIds: number[]) {
  const selectedSet = new Set(storyboardIds);
  const boards = await u.db("o_storyboardBoard").where({ projectId, scriptId });
  const staleBoards = boards.filter((board: any) => parseStoryboardIds(board.storyboardIds).some((id) => selectedSet.has(id)));
  if (!staleBoards.length) return;

  const runningBoard = staleBoards.find((board: any) => board.state === "生成中");
  if (runningBoard) {
    throw new Error(`故事板 ${runningBoard.id} 正在生成中，请完成后再重新生成`);
  }

  const staleBoardIds = staleBoards.map((board: any) => Number(board.id)).filter((id) => Number.isInteger(id));
  await Promise.all(
    staleBoards.flatMap((board: any) => [deleteOssFileIfExists(board.filePath), deleteOssFileIfExists(board.thumbPath)]),
  );
  await deleteBoardVideos(staleBoardIds);
  await u.db("o_storyboardBoard").whereIn("id", staleBoardIds).delete();
}

async function formatBoard(row: any) {
  const imageUrl = row.filePath ? await u.oss.getFileUrl(row.filePath) : "";
  const thumbUrl = row.thumbPath ? await u.oss.getFileUrl(row.thumbPath) : imageUrl ? u.oss.buildImagePreviewUrl(imageUrl, { width: 640, format: "webp" }) : "";
  return {
    ...row,
    storyboardIds: safeParseStoryboardIds(row.storyboardIds),
    imageUrl,
    thumbUrl,
  };
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    storyboardIds: z.array(z.number()).min(1),
    layout: z.enum(["script", "grid", "vertical", "horizontal"]).optional(),
    ratio: z.enum(["auto", "16:9", "9:16"]).optional(),
    itemsPerBoard: z.number().optional(),
    targetDuration: z.number().optional(),
  }),
  async (req, res) => {
    const {
      projectId,
      scriptId,
      layout = "script",
      targetDuration,
    } = req.body as {
      projectId: number;
      scriptId: number;
      storyboardIds: number[];
      layout?: StoryboardBoardLayout;
      ratio?: StoryboardBoardRatio;
      itemsPerBoard?: number;
      targetDuration?: number;
    };
    const imageRatio = STORYBOARD_BOARD_FIXED_IMAGE_RATIO;
    const storyboardIds = normalizeIds(req.body.storyboardIds);
    if (!storyboardIds.length) return res.status(400).send(error("请选择需要生成故事板的分镜"));

    const storyboards: StoryboardBoardInput[] = await u
      .db("o_storyboard")
      .where({ projectId, scriptId })
      .whereIn("id", storyboardIds)
      .orderBy("index", "asc")
      .select("id", "index", "filePath", "duration", "prompt", "videoDesc", "track");

    if (storyboards.length !== storyboardIds.length) {
      return res.status(400).send(error("存在不属于当前项目或剧集的分镜"));
    }
    const missingText = storyboards.find((item) => !String(item.videoDesc || item.prompt || "").trim());
    if (missingText) return res.status(400).send(error(`分镜 S${String(Number(missingText.index ?? 0) + 1).padStart(2, "0")} 缺少分镜文本`));

    const [project, script] = await Promise.all([
      u.db("o_project").where("id", projectId).select("name", "type", "imageModel", "imageQuality", "videoRatio", "artStyle", "directorManual").first(),
      u.db("o_script").where({ id: scriptId, projectId }).select("name", "content").first(),
    ]);
    if (!script) return res.status(400).send(error("剧集不存在或不属于当前项目"));
    if (!project?.imageModel) return res.status(400).send(error("项目未配置图片生成模型"));
    try {
      await replaceOverlappingBoards(projectId, scriptId, storyboards.map((item) => Number(item.id)).filter((id) => Number.isInteger(id)));
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }

    const baseContext: StoryboardBoardContext = {
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
      ratio: imageRatio,
      targetDuration: resolveTargetDuration(storyboards, targetDuration),
    };
    const segments = await planStoryboardBoardSegments(storyboards, baseContext);
    const responseBoards: any[] = [];
    const pendingJobs: Array<{ boardId: number; storyboards: StoryboardBoardInput[]; context: StoryboardBoardContext }> = [];

    for (const segment of segments) {
      const segmentStoryboards = segment.storyboards;
      if (!segmentStoryboards.length) continue;
      const segmentContext: StoryboardBoardContext = {
        ...baseContext,
        itemsPerBoard: segmentStoryboards.length,
        targetDuration: segment.targetDuration,
      };
      const sourceHash = computeStoryboardBoardSourceHash(segmentStoryboards, segmentContext);
      const existing = await u
        .db("o_storyboardBoard")
        .where({
          projectId,
          scriptId,
          sourceHash,
          layout,
          ratio: imageRatio,
          itemsPerBoard: segmentStoryboards.length,
          targetDuration: segment.targetDuration,
          sourceType: "scriptShotSheet:autoSegment",
        })
        .whereIn("state", ["已完成", "生成中"])
        .first();
      if (existing) {
        responseBoards.push(existing);
        continue;
      }

      const now = Date.now();
      const startIndex = Math.min(...segmentStoryboards.map((item) => Number(item.index ?? 0)));
      const endIndex = Math.max(...segmentStoryboards.map((item) => Number(item.index ?? 0)));
      const [boardId] = await u.db("o_storyboardBoard").insert({
        projectId,
        scriptId,
        storyboardIds: JSON.stringify(segmentStoryboards.map((item) => item.id)),
        startIndex,
        endIndex,
        layout,
        ratio: imageRatio,
        itemsPerBoard: segmentStoryboards.length,
        labelMode: "shotScript",
        sourceHash,
        sourceType: "scriptShotSheet:autoSegment",
        imageModel: project.imageModel,
        targetDuration: segment.targetDuration,
        state: "生成中",
        errorReason: "",
        createTime: now,
        updateTime: now,
      });
      const row = await u.db("o_storyboardBoard").where("id", boardId).first();
      responseBoards.push(row);
      pendingJobs.push({ boardId, storyboards: segmentStoryboards, context: segmentContext });
    }

    res.status(200).send(success(await Promise.all(responseBoards.map(formatBoard))));

    void (async () => {
      for (const job of pendingJobs) {
        try {
          const image = await generateStoryboardBoardImageFromScript(job.storyboards, job.context);
          await u.db("o_storyboardBoard").where("id", job.boardId).update({
            filePath: image.filePath,
            thumbPath: image.thumbPath,
            shotScript: image.shotScript,
            imagePrompt: image.imagePrompt,
            imageModel: image.imageModel,
            targetDuration: image.targetDuration,
            sourceHash: image.sourceHash,
            ratio: imageRatio,
            state: "已完成",
            errorReason: "",
            updateTime: Date.now(),
          });
        } catch (e) {
          const message = u.error(e).message;
          await u.db("o_storyboardBoard").where("id", job.boardId).update({
            state: "生成失败",
            errorReason: message,
            updateTime: Date.now(),
          });
        }
      }
    })();
  },
);
