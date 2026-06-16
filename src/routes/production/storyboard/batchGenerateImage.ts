import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";
import { assetItemSchema } from "@/agents/productionAgent/tools";
import { resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
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
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const {
      storyboardIds,
      projectId,
      scriptId,
    }: {
      storyboardIds: number[];
      projectId: number;
      scriptId: number;
    } = req.body;
    const concurrentCount = normalizeImageConcurrency(req.body.concurrentCount);
    if (!storyboardIds || storyboardIds.length === 0) return res.status(400).send(error("storyboardIds不能为空"));
    const finalStoryboardIds: number[] = storyboardIds || [];
    // 显式发起分镜生图时，以请求的 storyboardIds 为准；只跳过没有提示词的分镜。
    await u
      .db("o_storyboard")
      .whereIn("id", finalStoryboardIds)
      .where("scriptId", scriptId)
      .where((qb) => {
        qb.whereNull("prompt").orWhere("prompt", "");
      })
      .update({ state: "未生成", reason: "" });
    await u
      .db("o_storyboard")
      .whereIn("id", finalStoryboardIds)
      .where("scriptId", scriptId)
      .whereNotNull("prompt")
      .whereNot("prompt", "")
      .update({ state: "生成中", reason: "" });

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();

    const storyboardData = await u.db("o_storyboard").where("scriptId", scriptId).whereIn("id", finalStoryboardIds);
    const assetData = await resolveEffectiveStoryboardAssetReferences(finalStoryboardIds);

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
      if (Number.isInteger(item.imageId)) assetRecord[item.storyboardId].push(item.imageId);
    });

    res.status(200).send(
      success(
        storyboardData.map((i) => ({
          id: i.id,
          prompt: i.prompt,
          associateAssetsIds: assetIdRecord[i.id!],
          src: null,
          state: i.state,
          videoDesc: i.videoDesc,
          shouldGenerateImage: i.shouldGenerateImage,
        })),
      ),
    );
    const generateTask = async (item: (typeof storyboardData)[number]) => {
      try {
        const finalPrompt = buildStoryboardImagePrompt(item.prompt!, projectSettingData?.artStyle);
        const repeloadObj = {
          prompt: finalPrompt,
          size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: projectSettingData?.videoRatio as `${number}:${number}`,
        };

        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: await getAssetsImageBase64(assetRecord[item.id!] || []),
            ...repeloadObj,
          },
          {
            taskClass: "生成分镜图片",
            describe: `分镜图片生成，画风：${projectSettingData?.artStyle || "未指定"}，提示词：${finalPrompt}`,
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );

        const savePath = `/${projectId}/assets/${scriptId}/${u.uuid()}.jpg`;
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
    const generateList = storyboardData.filter((item) => item.prompt?.trim());
    const skippedIds = storyboardData.filter((item) => !item.prompt?.trim()).map((item) => item.id);
    if (skippedIds.length > 0) {
      console.log("[storyboard.batchGenerateImage] skip storyboards without prompt:", skippedIds);
    }
    await runWithConcurrency(generateList, concurrentCount, generateTask);
  },
);
async function getAssetsImageBase64(imageIds: number[]) {
  if (!imageIds.length) return [];
  const referenceBudget = getReferenceImageBudget(imageIds.length);

  const imagePaths = await u.db("o_image").whereIn("o_image.id", imageIds).select("o_image.id", "o_image.filePath");

  // 建立 id 到 filePath 的映射
  const id2Path = new Map<number, string>();
  for (const row of imagePaths) {
    id2Path.set(row.id, row.filePath);
  }

  // 保证输出顺序与 imageIds 一致
  const imageUrls = await Promise.all(
    imageIds.map(async (id) => {
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
  // 保留顺序，并且过滤掉无效项
  return (imageUrls.filter(Boolean) as string[]).map((url) => ({ type: "image" as const, base64: url }));
}
