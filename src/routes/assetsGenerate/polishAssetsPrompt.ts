import express from "express";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  buildAssetPrompt,
  buildRolePromptPresetDescribe,
  buildRolePromptPresetInstruction,
  enforceRolePromptPresetFinalPrompt,
} from "@/utils/assetsPrompt";
import { mediaPromptSafetyInstruction, stripMediaPromptSafetyInstruction } from "@/utils/promptSafety";
const router = express.Router();


type ItemType = "characters" | "props" | "scenes";

//润色提示词
export default router.post(
  "/",
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.string(),
    name: zod.string(),
    describe: zod.string(),
    prompt: zod.string().optional().nullable(),
    promptPreset: zod.string().optional().nullable(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, name, describe, prompt, promptPreset } = req.body;
    //获取风格
    const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    await u.db("o_assets").where("id", assetsId).update({ promptState: "生成中" });

    //查询资产是否是衍生资产
    const assetsData = await u.db("o_assets").where("id", assetsId).select("assetsId").first();
    if (!assetsData) return { code: 500, message: "资产不存在" };
    const typeConfig: Record<string, { promptKey: string; itemType: ItemType; label: string; nameLabel: string; visualManual: string }> = {
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
        visualManual: assetsData.assetsId ? "art_character_derivative" : "art_character",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
        visualManual: assetsData.assetsId ? "art_scene_derivative" : "art_scene",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
        visualManual: assetsData.assetsId ? "art_prop_derivative" : "art_prop",
      },
    };

    const config = typeConfig[type];
    if (!config) return res.status(500).send(error("不支持的类型"));
    if (!config.visualManual) return res.status(500).send(error("视觉手册未定义"));
    //获取到视觉手册
    const visualManual = await u.getArtPrompt(project.artStyle as string, "art_skills", config.visualManual);
    if (!visualManual) return res.status(500).send(error("视觉手册未定义"));
    const effectiveDescribe = buildRolePromptPresetDescribe(type, describe, promptPreset, prompt);
    const promptGuard = buildAssetPrompt({
      type: type as "role" | "scene" | "tool",
      name,
      describe: effectiveDescribe,
      prompt,
      artStyle: project.artStyle as string,
      derivative: Boolean(assetsData.assetsId),
    });
    const presetInstruction = buildRolePromptPresetInstruction(type, promptPreset, prompt, effectiveDescribe);
    const systemPrompt = `${visualManual}

额外硬约束：
${promptGuard}
${presetInstruction ? `\n女性角色风格预设约束：\n${presetInstruction}` : ""}
${mediaPromptSafetyInstruction()}

必须把用户提供的${config.nameLabel}描述作为最高优先级视觉依据。不要用通用模板、默认性别、默认发型、默认服装或模型习惯覆盖描述。
如果存在女性角色风格预设，必须从${config.nameLabel}描述里的“风格补充：妖艳”段落提取体态、服装优先级、抹胸遮挡和腿部线条要求，并融合进最终视觉提示词；不能只输出普通角色提示词，但也不要覆盖角色身份、年龄感、五官、体型和剧情设定。
最终只输出可直接用于图片生成的提示词，不要输出“安全表达要求”“额外硬约束”“风格预设约束”等说明性标题或规则原文。`;
    try {
      const { _output } = (await u.Ai.Text("universalAi").invoke({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `**基础参数：**
      **${config.nameLabel}设定：**
      - ${config.nameLabel}名称:${name},
      - ${config.nameLabel}描述:${effectiveDescribe},
      ${prompt ? `- 当前提示词/用户补充:${prompt},` : ""}
      ${presetInstruction ? "- 已选择女性提示词选项：妖艳，请优先读取并融合上方角色描述中的“风格补充：妖艳”段落，不要忽略该段。" : ""}

      输出要求：
      - 提示词必须显式吸收上述描述中的核心视觉特征。
      - 如果系统模板与描述冲突，以描述为准。
      - 只输出最终提示词正文，不要输出规则解释。`,
          },
        ],
      })) as any;

      if (!_output) return res.status(500).send("失败");
      const finalPrompt = enforceRolePromptPresetFinalPrompt(
        type,
        stripMediaPromptSafetyInstruction(String(_output || "")),
        promptPreset,
        [prompt, effectiveDescribe].filter(Boolean).join("\n"),
      );
      await u.db("o_assets").where("id", assetsId).update({ prompt: finalPrompt, describe: effectiveDescribe, promptState: "已完成" });

      res.status(200).send(success({ prompt: finalPrompt, describe: effectiveDescribe, assetsId }));
    } catch (e: any) {
      await u
        .db("o_assets")
        .where("id", assetsId)
        .update({ promptState: "失败", promptErrorReason: u.error(e).message });
      return res.status(500).send(error(e?.data?.error?.message ?? e?.message ?? "生成失败"));
    }
  },
);
