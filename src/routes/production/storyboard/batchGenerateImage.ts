import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";
import { assetItemSchema } from "@/agents/productionAgent/tools";
import { resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
import { sanitizeImagePromptForSubmission, stripMediaPromptSafetyInstruction } from "@/utils/promptSafety";
import { ensurePreviousStoryboardTailFrame } from "@/utils/videoTailFrame";
const router = express.Router();
export type AssetData = z.infer<typeof assetItemSchema>;
const DEFAULT_IMAGE_CONCURRENCY = 10;

function normalizeImageConcurrency(value: number | undefined) {
  if (value == null || value === 5) return DEFAULT_IMAGE_CONCURRENCY;
  return value;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await worker(item);
      }
    }),
  );
}

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number().optional(),
    concurrentCount: z.number().min(1).optional(),
    usePreviousVideoTailFrame: z.boolean().optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId?: number;
    } = req.body;
    const concurrentCount = normalizeImageConcurrency(req.body.concurrentCount);
    const usePreviousVideoTailFrame = Boolean(req.body.usePreviousVideoTailFrame);
    if (!storyboardIds || storyboardIds.length === 0) return res.status(400).send(error("storyboardIds不能为空"));
    const finalStoryboardIds = Array.from(new Set((storyboardIds || []).filter((id) => Number.isInteger(id))));
    if (!finalStoryboardIds.length) return res.status(400).send(error("storyboardIds不能为空"));

    const storyboardRows = await u.db("o_storyboard").where("projectId", projectId).whereIn("id", finalStoryboardIds);
    if (!storyboardRows.length) return res.status(404).send(error("未找到可重新生成的分镜"));
    const matchedStoryboardIds = storyboardRows.map((item) => item.id).filter((id): id is number => Number.isInteger(id));
    const alreadyGeneratingIds = new Set(
      storyboardRows.filter((item) => item.state === "生成中").map((item) => item.id).filter((id): id is number => Number.isInteger(id)),
    );
    const idsToStart = matchedStoryboardIds.filter((id) => !alreadyGeneratingIds.has(id));

    // 显式发起分镜生图时，以请求的 storyboardIds 为准；只跳过没有提示词的分镜。
    if (idsToStart.length) {
      await u
        .db("o_storyboard")
        .whereIn("id", idsToStart)
        .where("projectId", projectId)
        .where((qb) => {
          qb.whereNull("prompt").orWhere("prompt", "");
        })
        .update({ state: "未生成", reason: "" });
      await u
        .db("o_storyboard")
        .whereIn("id", idsToStart)
        .where("projectId", projectId)
        .whereNotNull("prompt")
        .whereNot("prompt", "")
        .update({ state: "生成中", reason: "", filePath: "" });
    }

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();

    const storyboardData = await u.db("o_storyboard").where("projectId", projectId).whereIn("id", matchedStoryboardIds);
    const assetData = await resolveEffectiveStoryboardAssetReferences(matchedStoryboardIds);

    const assetRecord: Record<number, number[]> = {};
    const assetIdRecord: Record<number, number[]> = {};
    assetData.forEach((item: any) => {
      if (!assetRecord[item.storyboardId]) {
        assetRecord[item.storyboardId] = [];
      }
      if (!assetIdRecord[item.storyboardId]) {
        assetIdRecord[item.storyboardId] = [];
      }
      assetIdRecord[item.storyboardId].push(item.id);
      if (Number.isInteger(item.imageId)) {
        assetRecord[item.storyboardId].push(item.imageId);
      }
    });

    res.status(200).send(
      success(
        storyboardData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetIdRecord[i.id!],
          src: null,
          thumbSrc: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
        })),
      ),
    );
    const generateTask = async (item: (typeof storyboardData)[number]) => {
      try {
        const tailFrame = usePreviousVideoTailFrame ? await getOptionalPreviousTailFrame(item, req) : null;
        const promptSource = appendPreviousTailFrameInstruction(
          buildStoryboardImagePrompt(item.prompt!, projectSettingData?.artStyle),
          Boolean(tailFrame),
        );
        const finalPrompt = sanitizeImagePromptForSubmission(
          stripMediaPromptSafetyInstruction(promptSource),
        );
        const repeloadObj = {
          prompt: finalPrompt,
          size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: projectSettingData?.videoRatio as `${number}:${number}`,
        };

        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: await getReferenceImageBase64(assetRecord[item.id!] || [], tailFrame?.filePath ? [tailFrame.filePath] : []),
            ...repeloadObj,
          },
          {
            taskClass: "生成分镜图片",
            describe: `分镜图片生成，画风：${projectSettingData?.artStyle || "未指定"}，提示词：${finalPrompt}`,
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );

        const savePath = `/${projectId}/assets/${item.scriptId || scriptId || "storyboard"}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        await u.db("o_storyboard").where("id", item.id).update({
          filePath: savePath,
          state: "已完成",
          reason: "",
        });
      } catch (e) {
        const message = u.error(e).message;
        console.error("[storyboard.batchGenerateImage] image generation failed", {
          id: item.id,
          index: item.index,
          projectId,
          scriptId,
          message,
        });
        await u
          .db("o_storyboard")
          .where("id", item.id)
          .update({
            filePath: "",
            reason: message,
            state: "生成失败",
          });
      }
    };

    // 固定并发 worker 队列：单个慢任务不会卡住后续批次。
    const generateList = storyboardData.filter((item) => item.prompt?.trim() && !alreadyGeneratingIds.has(item.id!));
    const skippedIds = storyboardData.filter((item) => !item.prompt?.trim()).map((item) => item.id);
    if (skippedIds.length > 0) {
      console.log("[storyboard.batchGenerateImage] skip storyboards without prompt:", skippedIds);
    }
    if (alreadyGeneratingIds.size > 0) {
      console.log("[storyboard.batchGenerateImage] skip storyboards already generating:", Array.from(alreadyGeneratingIds));
    }
    await runWithConcurrency(generateList, concurrentCount, generateTask);
  },
);

function appendPreviousTailFrameInstruction(prompt: string, hasTailFrame: boolean) {
  if (!hasTailFrame) return prompt;
  return [
    prompt,
    "连续性参考：参考图列表最后一张是上一分镜已生成视频的尾帧，只用于保持角色位置、姿态趋势、光影和镜头衔接；不要把上一分镜内容硬搬到当前分镜，当前分镜剧情、构图和可见主体仍以本提示词为准。",
  ].join("\n");
}

async function getOptionalPreviousTailFrame(item: any, req: any) {
  try {
    return await ensurePreviousStoryboardTailFrame(item, req);
  } catch (e) {
    const message = u.error(e).message;
    if (!/没有上一分镜|没有已完成的视频/.test(message)) {
      console.warn("[storyboard.batchGenerateImage] previous tail frame skipped:", {
        id: item.id,
        index: item.index,
        message,
      });
    }
    return null;
  }
}

async function getReferenceImageBase64(imageIds: number[], extraImagePaths: string[] = []) {
  const normalizedImageIds = imageIds.filter((id) => Number.isInteger(id));
  const queryImageIds = Array.from(new Set(normalizedImageIds));
  const uniqueExtraPaths = Array.from(new Set(extraImagePaths.map((filePath) => String(filePath || "").trim()).filter(Boolean)));
  if (!normalizedImageIds.length && !uniqueExtraPaths.length) return [];
  const referenceBudget = getReferenceImageBudget(normalizedImageIds.length + uniqueExtraPaths.length);

  const imagePaths = queryImageIds.length
    ? await u.db("o_image").whereIn("o_image.id", queryImageIds).select("o_image.id", "o_image.filePath")
    : [];

  // 建立 id 到 filePath 的映射
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) {
    id2Path.set(row.id, row.filePath);
  }

  // 保证输出顺序与 imageIds 一致
  const assetImageUrls = await Promise.all(
    normalizedImageIds.map(async (id) => {
      const filePath = id2Path.get(id);
      if (filePath) {
        try {
          return await urlToCompressedBase64(await u.oss.getFileUrl(filePath), referenceBudget);
        } catch {
          return null;
        }
      }
      return null;
    }),
  );
  const extraImageUrls = await Promise.all(
    uniqueExtraPaths.map(async (filePath) => {
      try {
        return await urlToCompressedBase64(await u.oss.getFileUrl(filePath), referenceBudget);
      } catch (e) {
        console.warn("[storyboard.batchGenerateImage] tail frame reference read failed:", filePath, u.error(e).message);
        return null;
      }
    }),
  );
  // 保留顺序，并且过滤掉无效项
  return ([...assetImageUrls, ...extraImageUrls].filter(Boolean) as string[]).map((url) => ({ type: "image" as const, base64: url }));
}
