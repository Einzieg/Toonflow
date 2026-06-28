import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";
import { resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { buildStoryboardImageStylePrompt } from "@/utils/assetsPrompt";
import { stripMediaPromptSafetyInstruction } from "@/utils/promptSafety";

const router = express.Router();

function normalizeText(value?: string | null) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function buildReferenceList(refs: Array<{ filePath?: string | null }>) {
  const paths = refs.map((item) => item.filePath).filter((item): item is string => !!item);
  const budget = getReferenceImageBudget(paths.length);
  const base64List = await Promise.all(
    paths.map(async (filePath) => {
      try {
        return await urlToCompressedBase64(await u.oss.getFileUrl(filePath), budget);
      } catch (e) {
        console.warn("[storyboard.generateGridImage] 参考图读取失败", filePath, u.error(e).message);
        return null;
      }
    }),
  );
  return base64List.filter(Boolean).map((base64) => ({ type: "image" as const, base64: base64! }));
}

function buildGridPrompt(input: {
  storyboard: any;
  refs: Array<{ name: string; type: string }>;
  artStyle?: string | null;
}) {
  const referenceLines = input.refs.map((ref, index) => {
    const typeLabel = ref.type === "scene" ? "场景" : "人物";
    return `@图${index + 1} 为${typeLabel}参考：${ref.name}`;
  });
  const storyboard = input.storyboard;
  const stylePrompt = buildStoryboardImageStylePrompt(input.artStyle);
  const sceneText = truncate(storyboard.videoDesc || storyboard.prompt || "", 1200);

  return stripMediaPromptSafetyInstruction(
    [
      stylePrompt,
      ...referenceLines,
      "为当前单条分镜生成一张 2x2 四宫格构图参考图，由同一场景和同一批人物构成。",
      "四个格子必须是同一镜头的导演参考拆解，不是四张无关海报；保持人物身份、服装、场景空间、光影方向一致。",
      "左上：场景建立，展示空间环境和人物初始站位。",
      "右上：人物关系，展示主要人物相对位置、朝向和距离。",
      "左下：动作节点，展示分镜关键动作发生的一瞬间。",
      "右下：情绪特写，展示核心人物表情、状态和戏剧张力。",
      "格子之间保留清晰分隔线或留白 gutter，但画面内不要出现任何文字、编号、字幕、水印、UI 或说明标签。",
      `当前分镜事实：${sceneText}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export default router.post(
  "/",
  validateFields({
    storyboardId: z.number(),
    projectId: z.number(),
    scriptId: z.number(),
    force: z.boolean().optional(),
  }),
  async (req, res) => {
    const { storyboardId, projectId, scriptId } = req.body;
    const storyboard = await u.db("o_storyboard").where({ id: storyboardId, projectId, scriptId }).first();
    if (!storyboard) return res.status(404).send(error("分镜不存在"));

    const project = await u.db("o_project").where("id", projectId).select("imageModel", "imageQuality", "artStyle", "videoRatio").first();
    if (!project?.imageModel) return res.status(400).send(error("项目未配置图片模型"));

    const allRefs = await resolveEffectiveStoryboardAssetReferences([storyboardId]);
    const refs = allRefs
      .filter((item) => ["scene", "role"].includes(String(item.type || "")) && item.filePath)
      .slice(0, 7)
      .map((item) => ({
        name: item.name || item.baseName || `资产${item.id}`,
        type: item.type,
        filePath: item.filePath,
      }));

    const hasScene = refs.some((item) => item.type === "scene");
    const hasRole = refs.some((item) => item.type === "role");
    if (!hasScene || !hasRole) {
      return res.status(400).send(error("生成四宫格需要当前分镜同时关联可用的场景图和人物图"));
    }

    const prompt = buildGridPrompt({ storyboard, refs, artStyle: project.artStyle });
    await u.db("o_storyboard").where("id", storyboardId).update({
      gridImageState: "生成中",
      gridImageReason: "",
      gridImagePrompt: prompt,
      gridImageFlowId: Date.now(),
    });

    res.status(200).send(success({ id: storyboardId, state: "生成中", prompt }));

    (async () => {
      try {
        const referenceList = await buildReferenceList(refs);
        const image = await u.Ai.Image(project.imageModel as `${string}:${string}`).run(
          {
            prompt,
            size: project.imageQuality as "1K" | "2K" | "4K",
            aspectRatio: (project.videoRatio || "16:9") as `${number}:${number}`,
            referenceList,
          },
          {
            taskClass: "生成分镜四宫格图",
            describe: `分镜四宫格图生成，分镜ID：${storyboardId}，画风：${project.artStyle || "未指定"}`,
            relatedObjects: JSON.stringify({ storyboardId, projectId, scriptId, referenceCount: referenceList.length }),
            projectId,
          },
        );
        const savePath = `/${projectId}/storyboardGrid/${scriptId}/${u.uuid()}.jpg`;
        await image.save(savePath);
        await u.db("o_storyboard").where("id", storyboardId).update({
          gridImagePath: savePath,
          gridImageState: "已完成",
          gridImageReason: "",
          gridImagePrompt: prompt,
          gridImageFlowId: Date.now(),
        });
      } catch (e) {
        await u.db("o_storyboard").where("id", storyboardId).update({
          gridImageState: "生成失败",
          gridImageReason: u.error(e).message,
        });
      }
    })();
  },
);
