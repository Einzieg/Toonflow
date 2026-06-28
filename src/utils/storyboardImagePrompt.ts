import u from "@/utils";
import { buildStoryboardImageStylePrompt } from "@/utils/assetsPrompt";
import { containsMediaPromptSafetyInstruction, mediaPromptSafetyInstruction, stripMediaPromptSafetyInstruction } from "@/utils/promptSafety";
import { stripThink } from "@/utils/stripThink";

export interface StoryboardImagePromptAsset {
  id?: number | null;
  name?: string | null;
  type?: string | null;
  describe?: string | null;
  baseName?: string | null;
}

export interface StoryboardImagePromptFields {
  no?: number | null;
  index?: number | null;
  description?: string | null;
  scene?: string | null;
  shot?: string | null;
  camera?: string | null;
  action?: string | null;
  emotion?: string | null;
  lighting?: string | null;
  dialogue?: string | null;
  sound?: string | null;
  duration?: number | string | null;
  videoDesc?: string | null;
}

const MAX_STORYBOARD_IMAGE_PROMPT_CHARS = 1100;

function normalizeText(value?: string | number | null) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCodeFence(value: string) {
  return value
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function getAssetTypeLabel(type?: string | null) {
  if (type === "scene") return "场景";
  if (type === "tool") return "道具";
  if (type === "clip") return "素材";
  return "角色";
}

function getMarkedField(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`【${escaped}】([^【]+)`));
  return normalizeText(match?.[1] || "");
}

export function normalizeStoryboardImagePromptFields(input: StoryboardImagePromptFields): Required<StoryboardImagePromptFields> {
  const videoDesc = normalizeText(input.videoDesc);
  return {
    no: input.no ?? input.index ?? null,
    index: input.index ?? input.no ?? null,
    description: normalizeText(input.description) || getMarkedField(videoDesc, "画面"),
    scene: normalizeText(input.scene) || getMarkedField(videoDesc, "场景"),
    shot: normalizeText(input.shot) || getMarkedField(videoDesc, "景别"),
    camera: normalizeText(input.camera) || getMarkedField(videoDesc, "运镜"),
    action: normalizeText(input.action) || getMarkedField(videoDesc, "动作"),
    emotion: normalizeText(input.emotion) || getMarkedField(videoDesc, "情绪"),
    lighting: normalizeText(input.lighting) || getMarkedField(videoDesc, "光影"),
    dialogue: normalizeText(input.dialogue) || getMarkedField(videoDesc, "台词"),
    sound: normalizeText(input.sound) || getMarkedField(videoDesc, "音效"),
    duration: input.duration ?? getMarkedField(videoDesc, "时长"),
    videoDesc,
  };
}

function formatAssetFacts(assets: StoryboardImagePromptAsset[]) {
  return assets
    .map((asset, index) => {
      const name = normalizeText(asset.name) || normalizeText(asset.baseName) || `资产${asset.id ?? index + 1}`;
      const typeLabel = getAssetTypeLabel(asset.type);
      const describe = normalizeText(asset.describe);
      return `参考图${index + 1}: ${name}（${typeLabel}${asset.id != null ? `, id=${asset.id}` : ""}）${describe ? `，视觉描述：${describe}` : ""}`;
    })
    .join("\n");
}

function hasRawRuleText(value: string) {
  return (
    containsMediaPromptSafetyInstruction(value) ||
    /可见主体清单|引用资产可见性硬约束|不能只作为参考图|不得把引用资产省略|必须作为实际拍摄环境|必须在构图中可见/.test(value)
  );
}

function missingReferenceIndexes(value: string, assets: StoryboardImagePromptAsset[]) {
  return assets
    .map((_asset, index) => index + 1)
    .filter(
      (index) =>
        !new RegExp(`@图\\s*${index}`).test(value) &&
        !new RegExp(`参考图\\s*${index}`).test(value) &&
        !new RegExp(`第\\s*${index}\\s*张参考图`).test(value),
    );
}

function buildReferenceLead(assets: StoryboardImagePromptAsset[]) {
  if (!assets.length) return "";
  const refs = assets
    .map((asset, index) => {
      const name = normalizeText(asset.name) || normalizeText(asset.baseName) || `${getAssetTypeLabel(asset.type)}${asset.id ?? index + 1}`;
      return `@图${index + 1}（${name}${getAssetTypeLabel(asset.type)}）`;
    })
    .join("、");
  return `画面参考${refs}，并用自然语言说明这些角色、道具或场景在同一镜头中的位置、动作和环境关系。`;
}

function ensureReferenceLead(prompt: string, assets: StoryboardImagePromptAsset[]) {
  if (!missingReferenceIndexes(prompt, assets).length) return prompt;
  return normalizeText([buildReferenceLead(assets), prompt].filter(Boolean).join(" "));
}

function sanitizePrompt(value: string) {
  return normalizeText(stripMediaPromptSafetyInstruction(stripCodeFence(stripThink(String(value || "")))))
    .replace(/^提示词[：:]\s*/i, "")
    .replace(/@图\s*(\d+)/g, "@图$1")
    .trim();
}

function buildFallbackNaturalPrompt(input: {
  fields: Required<StoryboardImagePromptFields>;
  assets: StoryboardImagePromptAsset[];
}) {
  const { fields, assets } = input;
  const assetPhrase = assets
    .map((asset, index) => {
      const name = normalizeText(asset.name) || normalizeText(asset.baseName) || `资产${asset.id ?? index + 1}`;
      const typeLabel = getAssetTypeLabel(asset.type);
      if (asset.type === "scene") return `以@图${index + 1}对应的${name}作为真实${typeLabel}环境`;
      if (asset.type === "tool") return `让@图${index + 1}对应的${name}${typeLabel}清晰出现在动作焦点附近`;
      return `让@图${index + 1}对应的${name}${typeLabel}以合理站位出现在画面中`;
    })
    .join("，");

  return normalizeText(
    [
      assetPhrase,
      `画面主体：${fields.description}`,
      `构图与镜头：${fields.scene}内，${fields.shot || "电影分镜"}构图，${fields.camera || "镜头稳定"}。`,
      `动作与表演：${fields.action || fields.description}，情绪为${fields.emotion || "贴合剧情"}。`,
      fields.lighting ? `环境氛围：${fields.lighting}。` : "",
      "所有被引用的角色、道具和场景都自然融入同一张首帧画面，不出现文字、字幕、水印、多余肢体或无关主体。",
    ]
      .filter(Boolean)
      .join(" "),
  ).slice(0, MAX_STORYBOARD_IMAGE_PROMPT_CHARS);
}

function buildAiPromptGenerationInput(input: {
  fields: Required<StoryboardImagePromptFields>;
  assets: StoryboardImagePromptAsset[];
  artStyle?: string | null;
  previousIssue?: string;
}) {
  const { fields, assets, artStyle, previousIssue } = input;
  return [
    previousIssue ? `上一次输出问题：${previousIssue}` : "",
    `项目画风：${normalizeText(artStyle) || "按项目既定画风"}`,
    `画风约束摘要：${buildStoryboardImageStylePrompt(artStyle)}`,
    "",
    "分镜事实：",
    `- 画面：${fields.description}`,
    `- 场景：${fields.scene}`,
    `- 景别：${fields.shot}`,
    `- 运镜：${fields.camera}`,
    `- 动作/朝向：${fields.action}`,
    `- 情绪：${fields.emotion}`,
    `- 光影氛围：${fields.lighting}`,
    `- 台词：${fields.dialogue}`,
    `- 音效：${fields.sound}`,
    "",
    "本次实际上传给生图模型的参考图顺序：",
    formatAssetFacts(assets) || "无参考图",
    "",
    "请输出一段可直接提交给生图模型的最终分镜图 prompt。",
    "要求：",
    "- 只输出最终 prompt 文本，不要解释，不要 Markdown，不要 XML。",
    "- 不要输出规则清单、检查清单、字段标签、可见主体清单或“引用资产可见性硬约束”字样。",
    "- 必须根据剧情场景组织真实构图：主体站位、前后景、动作焦点、道具位置、场景空间关系都要自然写进画面。",
    "- 保留并自然使用每张实际上传的 @图N 引用；可以写“@图N对应的角色名/场景名/道具名”，不要把角色名、场景名、道具名机械替换成孤立的 @图N。",
    "- @图N 是参考图锚点，不是正文替换符；最终 prompt 应同时包含 @图N 绑定和清楚的自然语言主体描述。",
    "- 资产名称若是状态/伤病/衣着标签，可在自然语言中安全改写，但不得删除或改写 @图N 引用本身。",
    "- 道具必须被持有、接触、放在动作焦点附近或作为明确前景物；场景参考图必须成为真实环境/背景空间。",
    "- 严格忠实分镜事实，不新增未引用角色、道具、场景或剧情结果。",
    `- ${mediaPromptSafetyInstruction().replace(/\n/g, " ")}`,
    "- 输出中文为主，控制在 700 字以内；禁止字幕、文字、水印、多余肢体。",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateStoryboardImagePromptWithAI(input: {
  fields: StoryboardImagePromptFields;
  assets: StoryboardImagePromptAsset[];
  artStyle?: string | null;
  projectId?: number | null;
  fallbackOnError?: boolean;
}) {
  const fields = normalizeStoryboardImagePromptFields(input.fields);
  const assets = input.assets;
  let previousIssue = "";
  let lastPrompt = "";

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { text } = await u.Ai.Text("universalAi").invoke({
        system: [
          "你是短剧分镜图生图提示词设计师。",
          "你的任务是把结构化分镜事实和参考图顺序，改写成可直接提交给图像生成模型的自然构图 prompt。",
          "内部规则只能用于生成，不允许原样输出到最终 prompt。",
        ].join("\n"),
        prompt: buildAiPromptGenerationInput({ fields, assets, artStyle: input.artStyle, previousIssue }),
        maxOutputTokens: 900,
      });
      const prompt = sanitizePrompt(text || "");
      lastPrompt = prompt;
      if (!prompt) {
        previousIssue = "模型返回空 prompt";
        continue;
      }
      if (prompt.length < 180) {
        previousIssue = `输出过短：${prompt.length} 字，必须生成完整构图描述`;
        continue;
      }
      const promptWithRefs = ensureReferenceLead(prompt, assets);
      lastPrompt = promptWithRefs;
      if (hasRawRuleText(promptWithRefs)) {
        previousIssue = "输出仍包含安全规则、检查清单或硬约束原文，必须改写成自然构图描述，不能把规则文字写进最终 prompt";
        continue;
      }
      const missing = missingReferenceIndexes(promptWithRefs, assets);
      if (missing.length) {
        previousIssue = `缺少参考图${missing.join("、")}的自然画面落点`;
        continue;
      }
      if (promptWithRefs.length > MAX_STORYBOARD_IMAGE_PROMPT_CHARS) {
        previousIssue = `输出过长：${promptWithRefs.length} 字，必须压缩到 ${MAX_STORYBOARD_IMAGE_PROMPT_CHARS} 字以内`;
        continue;
      }
      return promptWithRefs;
    }
    throw new Error(previousIssue || "模型未返回有效分镜图 prompt");
  } catch (error) {
    if (!input.fallbackOnError) {
      throw new Error(
        `分镜图提示词 AI 生成失败：${u.error(error).message}${lastPrompt ? `；最后输出：${lastPrompt.slice(0, 240)}` : ""}`,
      );
    }
    return buildFallbackNaturalPrompt({ fields, assets });
  }
}
