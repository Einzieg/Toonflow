import express from "express";
import u from "@/utils";
import { z } from "zod";
import sharp from "sharp";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { Output } from "ai";
import { buildAssetPrompt, buildAssetStyleGuard } from "@/utils/assetsPrompt";
const router = express.Router();
const runningAssetImageTasks = new Set<number>();
const DEFAULT_IMAGE_CONCURRENCY = 10;

function normalizeImageConcurrency(value: number | undefined) {
  if (value == null || value === 5) return DEFAULT_IMAGE_CONCURRENCY;
  return value;
}

async function generateDerivativePrompt(systemPrompt: string, userPrompt: string): Promise<string> {
  const newApiConfig = await u.db("o_vendorConfig").where("id", "new-api").select("inputValues", "enable").first();
  if (newApiConfig?.enable) {
    try {
      const inputValues = JSON.parse(newApiConfig.inputValues ?? "{}");
      const baseUrl = String(inputValues.baseUrl ?? "").replace(/\/+$/, "");
      const apiKey = String(inputValues.apiKey ?? "").replace(/^Bearer\s+/i, "");

      if (baseUrl && apiKey) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-5.5",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.7,
            max_tokens: 800,
            stream: false,
          }),
          signal: AbortSignal.timeout(90_000),
        });

        if (!response.ok) {
          throw new Error(`new-api prompt request failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (String(text || "").trim()) return String(text).trim();
        throw new Error("new-api prompt response is empty");
      }
    } catch (e) {
      console.warn("[production.assets.batchGenerateAssetsImage] fast prompt failed, fallback universalAi", u.error(e).message);
    }
  }

  const { text } = await u.Ai.Text("universalAi").invoke({
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return String(text || "").trim();
}

export default router.post(
  "/",
  validateFields({
    assetIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const { assetIds, projectId, scriptId } = req.body;
    const concurrentCount = normalizeImageConcurrency(req.body.concurrentCount);
    const uniqueAssetIds: number[] = Array.from(new Set<number>(assetIds.filter((id: number) => Number.isInteger(id))));
    console.log(
      `[production.assets.batchGenerateAssetsImage] request project=${projectId} script=${scriptId} ids=${JSON.stringify(assetIds)} unique=${JSON.stringify(uniqueAssetIds)} concurrent=${concurrentCount}`,
    );

    const projectSettingData = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle").first();
    if (!projectSettingData) {
      res.status(200).send(success([]));
      return;
    }

    const rawAssetsDataArr = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .whereIn("o_assets.id", uniqueAssetIds)
      .select(
        "o_assets.id",
        "o_assets.describe",
        "o_assets.name",
        "o_assets.type",
        "o_assets.assetsId",
        "o_assets.imageId as currentImageId",
        "o_image.state as currentImageState",
      );
    const assetsById = new Map(rawAssetsDataArr.map((item: any) => [item.id, item]));
    const assetsDataArr = uniqueAssetIds.map((id) => assetsById.get(id)).filter(Boolean);
    const missingIds = uniqueAssetIds.filter((id) => !assetsById.has(id));
    const skippedRunningIds: number[] = [];
    const pendingAssetsDataArr = assetsDataArr.filter((item: any) => {
      if (runningAssetImageTasks.has(item.id)) {
        skippedRunningIds.push(item.id);
        return false;
      }
      runningAssetImageTasks.add(item.id);
      return true;
    });
    console.log(
      `[production.assets.batchGenerateAssetsImage] found=${assetsDataArr.length} start=${pendingAssetsDataArr.length} skippedRunning=${JSON.stringify(skippedRunningIds)} missing=${JSON.stringify(missingIds)}`,
    );

    if (pendingAssetsDataArr.length === 0) {
      res.status(200).send(
        success(
          assetsDataArr.map((item: any) => ({
            id: item.id,
            state: item.currentImageState || "未生成",
            src: "",
          })),
        ),
      );
      return;
    }

    const assetsToRelease = pendingAssetsDataArr.map((item: any) => item.id);
    const parentIds = assetsDataArr.map((item) => item.assetsId).filter((id) => id !== null);
    const parentAssetsData = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .whereIn("o_assets.id", parentIds as number[])
      .select("o_assets.id", "o_image.filePath", "o_assets.describe");
    assetsDataArr.forEach((i: any) => {
      const parent = parentAssetsData.find((item) => item.id === i.assetsId);
      if (parent) {
        i.parentDescribe = parent.describe;
      }
    });
    const imageUrlRecord: Record<number, string> = {};
    parentAssetsData.forEach((item) => {
      if (item.filePath) imageUrlRecord[item.id] = item.filePath;
    });
    const rolePrompt = u.getArtPrompt(projectSettingData!.artStyle!, "art_skills", "art_character_derivative");
    const toolPrompt = u.getArtPrompt(projectSettingData!.artStyle!, "art_skills", "art_prop_derivative");
    const scenePrompt = u.getArtPrompt(projectSettingData!.artStyle!, "art_skills", "art_scene_derivative");
    const promptRecord: Record<string, { prompt: string }> = {
      role: {
        prompt: rolePrompt,
      },
      tool: {
        prompt: toolPrompt,
      },
      scene: {
        prompt: scenePrompt,
      },
    };
    // 先批量为所有 assets 创建 image 记录并标记为"生成中"
    const imageIdMap: Record<number, number> = {};
    for (const item of pendingAssetsDataArr) {
      if (item.currentImageId && item.currentImageState === "生成中") {
        await u
          .db("o_image")
          .where({ id: item.currentImageId })
          .update({ state: "生成失败", errorReason: "已被新的批量生成任务取代" });
      }
      const [imageId] = await u.db("o_image").insert({
        assetsId: item.id,
        type: item.type,
        state: "生成中",
        resolution: projectSettingData?.imageQuality,
        model: projectSettingData?.imageModel,
      });
      imageIdMap[item.id!] = imageId;
      await u.db("o_assets").where("id", item.id).update({ imageId: imageId });
    }

    const imageData: { id: number; state: string; src: string }[] = [];
    res.status(200).send(
      success(
        pendingAssetsDataArr.map((item: any) => ({
          id: item.id,
          state: "生成中",
          src: "",
        })),
      ),
    );
    const generateSingleAsset = async (item: any) => {
      const imageId = imageIdMap[item.id!];
      const typeConfig = promptRecord[item.type!] || promptRecord["role"];
      const styleGuard = buildAssetStyleGuard(projectSettingData?.artStyle);

      try {
        const promptGuard = buildAssetPrompt({
          type: item.type as "role" | "scene" | "tool",
          name: item.name,
          describe: item.describe,
          prompt: item.parentDescribe,
          artStyle: projectSettingData?.artStyle,
          derivative: true,
        });
        const userPrompt = `
              项目画风: ${projectSettingData?.artStyle || "未指定"}
              ${promptGuard}
              父级资产描述: ${item.parentDescribe || "无详细描述"}
              当前资产描述: ${item.describe || "无详细描述"}`;
        console.log(`[production.assets.batchGenerateAssetsImage] prompt start asset=${item.id} name=${item.name} imageId=${imageId}`);
        const text = await generateDerivativePrompt(`${typeConfig.prompt}\n\n${styleGuard}`, userPrompt);
        if (!text) throw new Error("衍生资产提示词生成为空");
        const finalPrompt = `${text}\n\n${styleGuard}`;
        await u.db("o_assets").where("id", item.id).update({ prompt: finalPrompt });
        console.log(`[production.assets.batchGenerateAssetsImage] prompt completed asset=${item.id} name=${item.name} imageId=${imageId}`);

        const imageBase64 = imageUrlRecord[item.assetsId!] ? await u.oss.getImageBase64(imageUrlRecord[item.assetsId!]) : null;
        const repeloadObj = {
          prompt: finalPrompt,
          size: projectSettingData?.imageQuality as "1K" | "2K" | "4K",
          aspectRatio: "16:9" as `${number}:${number}`,
        };
        console.log(`[production.assets.batchGenerateAssetsImage] generating asset=${item.id} name=${item.name} imageId=${imageId}`);
        const imageCls = await u.Ai.Image(projectSettingData?.imageModel as `${string}:${string}`).run(
          {
            referenceList: imageBase64 ? [{ type: "image", base64: imageBase64 }] : [],
            ...repeloadObj,
          },
          {
            taskClass: "生成图片",
            describe: `资产图片生成，名称：${item.name}，画风：${projectSettingData?.artStyle || "未指定"}，提示词：${finalPrompt}`,
            relatedObjects: JSON.stringify(repeloadObj),
            projectId: projectId,
          },
        );
        const savePath = `/${projectId}/assets/${scriptId}/${item.type}/${u.uuid()}.jpg`;
        await imageCls.save(savePath);
        await u.db("o_image").where({ id: imageId }).update({ state: "已完成", filePath: savePath });
        console.log(`[production.assets.batchGenerateAssetsImage] completed asset=${item.id} imageId=${imageId}`);
        return {
          id: item.id!,
          state: "已完成",
          src: await u.oss.getSmallImageUrl(savePath),
        };
      } catch (e) {
        console.error(`[production.assets.batchGenerateAssetsImage] failed asset=${item.id} name=${item.name} imageId=${imageId}`, u.error(e).message);
        await u
          .db("o_image")
          .where({ id: imageId })
          .update({ state: "生成失败", errorReason: u.error(e).message });
        return {
          id: item.id!,
          state: "生成失败",
          src: "",
        };
      } finally {
        runningAssetImageTasks.delete(item.id);
      }
    };

    // 按 concurrentCount 分批并发执行
    (async () => {
      try {
        for (let i = 0; i < pendingAssetsDataArr.length; i += concurrentCount) {
          const batch = pendingAssetsDataArr.slice(i, i + concurrentCount);
          const batchResults = await Promise.all(batch.map(generateSingleAsset));
          imageData.push(...batchResults);
        }
      } catch (e) {
        console.error("[production.assets.batchGenerateAssetsImage] batch failed", u.error(e).message);
      } finally {
        assetsToRelease.forEach((id) => runningAssetImageTasks.delete(id));
      }
    })();
  },
);
