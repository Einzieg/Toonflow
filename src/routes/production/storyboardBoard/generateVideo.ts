import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { REMOTE_VIDEO_URL_TTL_MS, getPublicOssFileUrl } from "@/utils/videoSource";
import { buildStoryboardBoardVideoPrompt, type StoryboardBoardInput } from "@/utils/storyboardBoard";
import { resolveVideoGenerationDuration } from "@/utils/storyboardTrack";

const router = express.Router();

function parseStoryboardIds(value?: string | null): number[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)).filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function modeSupportsSingleImage(mode: unknown) {
  if (!Array.isArray(mode)) return false;
  return mode.some((item) => item === "singleImage" || (Array.isArray(item) && item.includes("singleImage")));
}

async function getVideoModelDetail(model: string) {
  const [vendorId, modelName] = model.split(/:(.+)/);
  if (!vendorId || !modelName) throw new Error("视频模型格式不正确");
  const models = await u.vendor.getModelList(vendorId);
  const detail = models.find((item: any) => item.modelName === modelName);
  if (!detail) throw new Error("视频模型不存在或供应商未启用");
  if (!modeSupportsSingleImage(detail.mode)) throw new Error("当前模型不支持单图生视频");
  return detail;
}

function getSupportedDurations(detail: any) {
  const durations = new Set<number>();
  if (Array.isArray(detail?.durationResolutionMap)) {
    detail.durationResolutionMap.forEach((item: any) => {
      if (Array.isArray(item.duration)) {
        item.duration.forEach((duration: any) => {
          const value = Number(duration);
          if (Number.isFinite(value)) durations.add(value);
        });
      }
    });
  }
  return Array.from(durations);
}

function getSupportedResolutions(detail: any, duration: number) {
  const resolutions = new Set<string>();
  if (Array.isArray(detail?.durationResolutionMap)) {
    detail.durationResolutionMap.forEach((item: any) => {
      const itemDurations = Array.isArray(item.duration) ? item.duration.map((value: any) => Number(value)) : [];
      if (!itemDurations.length || itemDurations.includes(duration)) {
        (Array.isArray(item.resolution) ? item.resolution : []).forEach((resolution: any) => {
          if (resolution) resolutions.add(String(resolution));
        });
      }
    });
  }
  return Array.from(resolutions);
}

function shouldUsePublicImageReference(model: string) {
  const [vendorId] = String(model || "").split(/:(.+)/);
  return vendorId === "cliproxyapi";
}

export default router.post(
  "/",
  validateFields({
    boardId: z.number(),
    model: z.string(),
    duration: z.number(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const { boardId, model, duration, resolution, audio = false } = req.body as {
      boardId: number;
      model: string;
      duration: number;
      resolution: string;
      audio?: boolean;
    };

    const board = await u.db("o_storyboardBoard").where("id", boardId).first();
    if (!board) return res.status(404).send(error("故事板不存在"));
    if (board.state !== "已完成" || !board.filePath) return res.status(400).send(error("故事板未生成完成"));
    const boardFilePath = String(board.filePath);
    const projectId = Number(board.projectId);
    const scriptId = Number(board.scriptId);
    if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) return res.status(400).send(error("故事板缺少项目或剧集信息"));

    const running = await u.db("o_storyboardBoardVideo").where({ boardId, state: "生成中" }).orderBy("createTime", "desc").first();
    if (running) {
      return res.status(200).send(success({ id: running.id, videoId: running.videoId, prompt: running.prompt, reused: true }));
    }

    let modelDetail: any;
    try {
      modelDetail = await getVideoModelDetail(model);
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }

    const effectiveDuration = resolveVideoGenerationDuration(model, duration, modelDetail.name);
    const supportedDurations = getSupportedDurations(modelDetail);
    if (supportedDurations.length && !supportedDurations.includes(effectiveDuration)) {
      return res.status(400).send(error(`当前模型不支持 ${effectiveDuration}s 时长，可用时长：${supportedDurations.join(", ")}s`));
    }
    const supportedResolutions = getSupportedResolutions(modelDetail, effectiveDuration);
    if (supportedResolutions.length && !supportedResolutions.includes(resolution)) {
      return res.status(400).send(error(`当前模型不支持 ${resolution} 分辨率，可用分辨率：${supportedResolutions.join(", ")}`));
    }
    if (audio && modelDetail.audio === false) {
      return res.status(400).send(error("当前模型不支持生成音频"));
    }

    const storyboardIds = parseStoryboardIds(board.storyboardIds);
    const storyboards: StoryboardBoardInput[] = storyboardIds.length
      ? await u.db("o_storyboard").whereIn("id", storyboardIds).orderBy("index", "asc").select("id", "index", "duration", "prompt", "videoDesc", "track")
      : [];
    const prompt = await buildStoryboardBoardVideoPrompt(storyboards, model, effectiveDuration, board.shotScript);
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`;
    const now = Date.now();
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: now,
      state: "生成中",
      localSaveState: "未保存",
      scriptId,
      projectId,
      videoTrackId: null,
    });
    const [boardVideoId] = await u.db("o_storyboardBoardVideo").insert({
      boardId,
      projectId,
      scriptId,
      videoId,
      referenceMode: "storyboardImage",
      model,
      prompt,
      duration: effectiveDuration,
      resolution,
      state: "生成中",
      errorReason: "",
      createTime: now,
      updateTime: now,
    });

    res.status(200).send(success({ id: boardVideoId, videoId, prompt }));

    (async () => {
      try {
        const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
        const aiVideo = u.Ai.Video(model as `${string}:${string}`);
        const referenceImage = shouldUsePublicImageReference(model) ? await getPublicOssFileUrl(boardFilePath, req) : await u.oss.getImageBase64(boardFilePath);
        await aiVideo.run(
          {
            prompt,
            referenceList: [
              {
                type: "image",
                base64: referenceImage,
              },
            ],
            mode: ["singleImage"],
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
            describe: "根据故事板页和分镜头脚本生成视频",
            relatedObjects: JSON.stringify({
              projectId,
              scriptId,
              boardId,
              videoId,
              type: "故事板视频",
            }),
          },
        );

        const remoteUrl = aiVideo.getRemoteUrl();
        if (remoteUrl) {
          await u.db("o_video").where("id", videoId).update({
            state: "已完成",
            remoteUrl,
            remoteUrlExpireTime: Date.now() + REMOTE_VIDEO_URL_TTL_MS,
            localSaveState: "保存中",
            localSaveErrorReason: "",
          });
          await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
            state: "已完成",
            errorReason: "",
            updateTime: Date.now(),
          });

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
          return;
        }

        await aiVideo.save(videoPath);
        await u.db("o_video").where("id", videoId).update({
          state: "已完成",
          localSaveState: "已保存",
          localSaveErrorReason: "",
        });
        await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
          state: "已完成",
          errorReason: "",
          updateTime: Date.now(),
        });
      } catch (e) {
        const message = u.error(e).message;
        await u.db("o_video").where("id", videoId).update({
          state: "生成失败",
          errorReason: message,
        });
        await u.db("o_storyboardBoardVideo").where("id", boardVideoId).update({
          state: "生成失败",
          errorReason: message,
          updateTime: Date.now(),
        });
      }
    })();
  },
);
