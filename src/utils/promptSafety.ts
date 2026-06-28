export function mediaPromptSafetyInstruction(): string {
  return [
    "安全表达要求：生成图片或视频提示词时，避免使用违禁词、直白裸露词、成人化或性暗示词汇。",
    "涉及衣着缺失、受伤、贫困、泥污或原始状态时，用衣着完整但破旧、衣着简陋、衣衫沾满泥污、自然妆等安全视觉表达替代。",
    "保持剧情含义，但不要在最终 prompt 中写可能触发上游安全拦截的敏感词原文。",
  ].join("\n");
}

function normalizeInstructionText(value: string): string {
  return String(value || "")
    .replace(/^[\s>*\-•]+/, "")
    .replace(/\s+/g, "")
    .trim();
}

function getSafetyInstructionLines(): string[] {
  return mediaPromptSafetyInstruction()
    .split("\n")
    .map(normalizeInstructionText)
    .filter(Boolean);
}

function isSafetyInstructionLine(value: string): boolean {
  const normalized = normalizeInstructionText(value);
  if (!normalized) return false;
  return getSafetyInstructionLines().some((line) => normalized.includes(line));
}

export function containsMediaPromptSafetyInstruction(value: string): boolean {
  return String(value || "")
    .split("\n")
    .some(isSafetyInstructionLine);
}

export function stripMediaPromptSafetyInstruction(value: string): string {
  return String(value || "")
    .split("\n")
    .filter((line) => !isSafetyInstructionLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const IMAGE_PROMPT_SAFE_REWRITES: Array<[RegExp, string]> = [
  [/黑狐幼崽（黑毛幼年形态）从草丛中猛然弹射扑出，前爪按住@图\d+\s*野兔，獠牙[^。]*。?/g, "黑狐幼崽（黑毛幼年形态）从草丛中警觉跃出，前爪按住受惊的小动物，周围草叶和暗色泥点飞散。"],
  [/野兔短促[^。]*逐渐静止/g, "小动物受惊蜷缩在草丛边"],
  [/他身边散落着@图\d+黑狐幼崽定装 对应的深色动物[^，。]*[，。]/g, "他身边散落着深色泥块、草屑和凌乱脚印，"],
  [/发出压抑的、类似小兽悲鸣的呜咽声/g, "呼吸急促，发出压低的喘息声"],
  [/温热?血液/g, "暗色泥点"],
  [/血液|血迹|鲜血|血浆|流血|出血/g, "暗色痕迹"],
  [/血肉|残骸碎块|尸块|尸体|残骸|碎块/g, "散落的暗色泥块"],
  [/獠牙精准?刺入[^，。；,.]*喉咙/g, "利齿压制住猎物"],
  [/刺入[^，。；,.]*喉咙/g, "压制住颈侧"],
  [/獠牙|利齿/g, "尖牙"],
  [/喉咙剧烈抽搐/g, "颈部和肩背紧绷"],
  [/喉咙|咽喉/g, "颈侧"],
  [/干呕/g, "明显不适"],
  [/呜咽|悲鸣/g, "压抑低声"],
  [/溃烂流脓|溃烂|流脓|病疮/g, "伤处用布料遮住"],
  [/血和泥|泥血/g, "泥土"],
  [/割喉|斩首|砍头|开膛|肢解/g, "激烈冲突"],
  [/惨叫/g, "短促惊叫"],
  [/四肢痉挛|痉挛/g, "身体僵住"],
  [/死亡|死去|杀死/g, "失去反抗"],
  [/踩住|碾压/g, "压制"],
  [/血腥|暴力|猎杀/g, "高压冲突"],
];

export function sanitizeImagePromptForSubmission(value: string): string {
  return IMAGE_PROMPT_SAFE_REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value || ""))
    .replace(/\s{2,}/g, " ")
    .trim();
}
