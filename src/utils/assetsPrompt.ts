type BuildRoleAssetPromptInput = {
  name: string;
  describe?: string | null;
  prompt?: string | null;
  artStyle?: string | null;
  derivative?: boolean;
};

type AssetPromptType = "role" | "scene" | "tool";

type BuildAssetPromptInput = BuildRoleAssetPromptInput & {
  type: AssetPromptType;
};

const ROLE_STYLE_SUMMARY: Record<string, string> = {
  realpeople_urban_modern: "真人都市写实，影视级纪实质感，现代都市角色设定图，强调真实皮肤、发丝与服装材质。",
  realpeople_ancient_chinese: "真人古风写实，影视级纪实质感，东方古风人物设定图，强调真实肌理与古风服化细节。",
  "3D_anime_render": "3D 动画渲染，赛璐珞质感，电影级打光，角色轮廓和材质层次清晰。",
  "3D_chinese_traditional": "国风 3D 高精度建模，东方美学角色设定图，强调体积感、材质与传统造型。",
  "3D_clay_stopmotion": "定格黏土动画质感，保留手工肌理与造型一致性，角色轮廓清晰可辨。",
  "2D_90s_japanese_anime": "90 年代日式动画手绘平涂风格，角色识别锚点清晰，线条稳定。",
  "2D_chinese_guofeng": "国风二次元新国潮风格，角色造型与服饰特征优先，线条细腻。",
  "2D_flat_design": "2D 扁平风，几何造型与纯色色块，角色轮廓和标识特征必须明确。",
  "2D_mature_urban_romance": "成熟都市言情二次元风格，电影感光影与人物气质统一，强调角色识别度。",
};

const SCENE_STYLE_SUMMARY: Record<string, string> = {
  realpeople_urban_modern: "真人都市写实场景，影视级纪实质感，强调真实空间光照、材质和环境纵深。",
  realpeople_ancient_chinese: "真人古风写实场景，东方电影质感，强调真实建筑、器物、光影与空间层次。",
  "3D_anime_render": "3D 动画场景渲染，电影级灯光和空间透视，场景层次与材质必须清晰。",
  "3D_chinese_traditional": "国风 3D 场景设定图，东方建筑和环境材质表现明确，空间结构稳定。",
  "3D_clay_stopmotion": "定格黏土场景质感，保留手工肌理，空间结构、材质和光影关系清晰。",
  "2D_90s_japanese_anime": "90 年代日式动画场景风格，背景手绘感明确，空间结构和氛围色调稳定。",
  "2D_chinese_guofeng": "新国风场景设定图，环境元素、建筑细节和氛围光色优先。",
  "2D_flat_design": "2D 扁平场景设计，几何结构、空间分区和视觉锚点必须明确。",
  "2D_mature_urban_romance": "成熟都市言情场景风格，强调环境氛围、电影感光影与叙事情绪。",
};

const TOOL_STYLE_SUMMARY: Record<string, string> = {
  realpeople_urban_modern: "真人都市写实道具设定图，影视级纪实质感，强调材质、结构、磨损与功能可读性。",
  realpeople_ancient_chinese: "真人古风写实道具设定图，东方器物质感明确，强调材质、工艺和时代一致性。",
  "3D_anime_render": "3D 动画道具渲染，造型、材质与结构清晰，功能识别明确。",
  "3D_chinese_traditional": "国风 3D 道具设定图，器物结构、纹样和材质层次准确。",
  "3D_clay_stopmotion": "定格黏土道具质感，保留手工肌理，同时保证结构和材质识别。",
  "2D_90s_japanese_anime": "90 年代日式动画道具风格，轮廓、材质符号和结构锚点清晰。",
  "2D_chinese_guofeng": "新国风道具设定图，纹样、材质与器形识别明确。",
  "2D_flat_design": "2D 扁平道具设计，结构、配色和功能分区必须明确。",
  "2D_mature_urban_romance": "成熟都市言情道具风格，强调材质细节和叙事属性。",
};

const TEMPLATE_FRAGMENT_KEYWORDS = [
  "女性角色四视图设定图",
  "男性角色四视图设定图",
  "角色四视图设定图",
  "人物角色四视图",
  "character design sheet",
  "character turnaround",
  "真人写实摄影",
  "都市写实纪实",
  "极致细节",
  "强对比度",
  "基础内衣",
  "四角内裤",
  "无发饰",
  "纯净中性灰背景",
  "纯净灰底",
  "同一画面左至右并排",
  "四视图一致性",
  "图中不要有任何文字",
  "portrait closeup",
  "front view",
  "side view",
  "back view",
  "full body head to toe",
  "head to collarbone complete",
  "height mark",
];

const SCENE_TEMPLATE_FRAGMENT_KEYWORDS = [
  "场景四视图设定图",
  "场景衍生四视图设定图",
  "scene design sheet",
  "environment concept art",
  "real photography",
  "photorealistic",
  "shot on arri alexa",
  "35mm film grain",
  "raw photo",
  "ultra realistic",
  "hyper detailed",
  "shallow depth of field",
  "lens vignette",
  "chromatic aberration",
  "bokeh",
  "前视图",
  "右视图",
  "后视图",
  "左视图",
  "同一画面2×2网格排列",
  "从场景中心点环视",
  "no people",
  "no characters",
  "no human figures",
  "图中不要有任何文字",
  "空气透视",
  "自然光漫射",
  "体积光",
  "丁达尔效应",
  "焦散投影",
  "墙面剥落",
  "金属氧化",
];

const TOOL_TEMPLATE_FRAGMENT_KEYWORDS = [
  "道具设定图",
  "纯道具静物展示",
  "道具独立陈列",
  "无人持有",
  "无人佩戴",
  "同一画面四宫格",
  "左上正面图",
  "右上侧面图",
  "左下背面图",
  "右下细节特写",
  "纯净中性灰背景",
  "均匀柔光",
  "无硬阴影",
  "图中不要有任何文字",
  "画面中不能出现任何人物",
  "真实摄影风格",
  "都市写实纪实",
  "强对比度",
  "极致细节",
  "材质纹理超清晰",
  "质感写实",
];

const GENERIC_ROLE_DEFAULT_KEYWORDS = [
  "鹅蛋脸",
  "自然双眼皮",
  "眼神清澈",
  "自然眉形",
  "原生眉",
  "鼻梁自然",
  "鼻型精致",
  "鼻型端正",
  "薄唇",
  "唇色自然",
  "面容自然",
  "面容平静",
  "五官立体",
  "自然状态",
  "自然肤色",
  "均匀肤色",
  "健康肤色",
  "暖白肤",
  "皮肤自然",
  "皮肤健康",
  "皮肤细腻",
  "毛孔微可见",
  "170cm tall",
  "165cm tall",
  "180cm tall",
  "7.5 heads tall proportion",
  "8 heads tall proportion",
  "身材纤细",
  "身材匀称",
  "身形匀称",
  "身形修长",
  "瘦高体型",
  "体态自然",
  "体态沉稳",
  "身姿舒展",
  "深棕色及肩发",
  "深棕色及腰长发",
  "深棕色自然短发",
  "发丝根根分明",
  "自然散发",
  "浅灰色",
  "基础服装",
];

const NON_HUMAN_KEYWORDS = [
  "无性别",
  "非人",
  "异形",
  "怪物",
  "守卫",
  "守门人",
  "意识体",
  "残影",
  "能量体",
  "人形轮廓",
  "无五官",
  "光影",
  "符号",
  "触手",
  "眼球",
  "巨眼",
  "机械",
  "机甲",
  "复制体",
  "异典",
  "甲壳",
  "外骨骼",
  "半透明",
  "空壳",
  "神像",
  "光芒构成",
];

function normalizeText(value?: string | null) {
  return String(value || "")
    .replace(/\r?\n+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitPromptFragments(prompt?: string | null) {
  return normalizeText(prompt)
    .split(/[\n,，。；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(values: string[]) {
  return [...new Set(values)];
}

function isTemplateFragment(fragment: string, keywords: string[]) {
  const lower = fragment.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function isGenericDefaultFragment(fragment: string) {
  const lower = fragment.toLowerCase();
  return (
    GENERIC_ROLE_DEFAULT_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase())) ||
    /^\d{2,3}cm tall$/i.test(fragment) ||
    /\b[678](?:\.5)? heads tall proportion\b/i.test(fragment)
  );
}

function looksLikeTemplatedPrompt(prompt: string | null | undefined, keywords: string[]) {
  const lower = normalizeText(prompt).toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function extractPromptAnchors(prompt?: string | null, options?: { nonHumanRole?: boolean }) {
  if (!normalizeText(prompt) || options?.nonHumanRole) {
    return [];
  }

  const templatedPrompt = looksLikeTemplatedPrompt(prompt, TEMPLATE_FRAGMENT_KEYWORDS);
  return dedupe(
    splitPromptFragments(prompt)
      .filter((fragment) => !isTemplateFragment(fragment, TEMPLATE_FRAGMENT_KEYWORDS))
      .filter((fragment) => !(templatedPrompt && isGenericDefaultFragment(fragment)))
      .filter((fragment) => fragment.length >= 2 && fragment.length <= 80),
  ).slice(0, 10);
}

function extractScenePromptAnchors(prompt?: string | null) {
  if (!normalizeText(prompt) || looksLikeTemplatedPrompt(prompt, SCENE_TEMPLATE_FRAGMENT_KEYWORDS)) {
    return [];
  }

  return dedupe(
    splitPromptFragments(prompt)
      .filter((fragment) => !isTemplateFragment(fragment, SCENE_TEMPLATE_FRAGMENT_KEYWORDS))
      .filter((fragment) => fragment.length >= 2 && fragment.length <= 80),
  ).slice(0, 8);
}

function extractToolPromptAnchors(prompt?: string | null) {
  if (!normalizeText(prompt) || looksLikeTemplatedPrompt(prompt, TOOL_TEMPLATE_FRAGMENT_KEYWORDS)) {
    return [];
  }

  return dedupe(
    splitPromptFragments(prompt)
      .filter((fragment) => !isTemplateFragment(fragment, TOOL_TEMPLATE_FRAGMENT_KEYWORDS))
      .filter((fragment) => fragment.length >= 2 && fragment.length <= 80),
  ).slice(0, 8);
}

function isNonHumanRole(text: string) {
  return NON_HUMAN_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function buildRoleAssetPrompt(input: BuildRoleAssetPromptInput) {
  const name = normalizeText(input.name);
  const describe = normalizeText(input.describe);
  const roleText = [name, describe].filter(Boolean).join(" ");
  const nonHumanRole = isNonHumanRole(roleText);
  const anchors = extractPromptAnchors(input.prompt, { nonHumanRole });
  const styleSummary = ROLE_STYLE_SUMMARY[input.artStyle || ""] || "遵循项目既定画风与材质风格，保持角色识别清晰。";

  const lines = [
    styleSummary,
    input.derivative
      ? "角色衍生设定图。必须保留原角色身份锚点，只允许改变当前描述明确提到的状态、服装、阶段、伤痕或装备。"
      : "角色设定图。必须优先遵循角色描述，不要生成模板化通用人物。",
    `角色名称：${name}。`,
    describe ? `核心角色描述：${describe}。` : "",
    anchors.length ? `补充视觉锚点：${anchors.join("，")}。` : "",
    "角色描述的优先级高于历史 prompt、通用模板和模型默认习惯，凡是与描述冲突的内容一律不要采用。",
    nonHumanRole
      ? "该角色不是标准真人模特。必须完整保留非人、异形、能量体、机械体、无性别体或符号化结构特征，绝对不要自动人类化。"
      : "如果是人类角色，必须保留描述中已有的性别、年龄感、五官气质、发型、服装、体型与状态，不要擅自改动。",
    nonHumanRole ? "不要补出人类皮肤、头发、眉眼鼻唇、妆容、内衣、模特站姿或标准男女脸。" : "",
    "如果原描述没有明确某项，不要自行补成默认深棕长发、默认妆容、默认年轻男女模特、默认基础内衣模板。",
    "只提炼与角色识别有关的视觉锚点：头部结构、五官或无五官特征、发型或头部特征、体型比例、服装或外壳、材质、符号、伤痕、颜色、发光部位。",
    "输出形式：同一画面展示肖像特写、正视图、侧视图、后视图；四视图必须是同一个角色，外观完全一致。",
    "纯净灰底，单角色设定图，无场景，无道具，无多余文字。",
  ].filter(Boolean);

  return lines.join("\n");
}

export function buildSceneAssetPrompt(input: BuildRoleAssetPromptInput) {
  const name = normalizeText(input.name);
  const describe = normalizeText(input.describe);
  const anchors = extractScenePromptAnchors(input.prompt);
  const styleSummary = SCENE_STYLE_SUMMARY[input.artStyle || ""] || "遵循项目既定场景风格，保持空间结构、光影与材质一致。";

  const lines = [
    styleSummary,
    input.derivative
      ? "场景衍生设定图。必须保留原场景的空间结构、主材质和核心环境锚点，只允许改变当前描述明确提到的时段、天气、损坏状态、氛围或功能区。"
      : "场景设定图。必须优先遵循场景描述，不要生成模板化通用公寓、街道或数据中心。",
    `场景名称：${name}。`,
    describe ? `核心场景描述：${describe}。` : "",
    anchors.length ? `补充环境锚点：${anchors.join("，")}。` : "",
    "场景描述的优先级高于历史 prompt、通用模板和模型默认习惯，凡是与描述冲突的内容一律不要采用。",
    "如果描述涉及异空间、深海、遗迹、意识空间、灾变环境或超现实结构，必须完整保留这些世界观特征，不要自动改成普通现代室内外模板。",
    "必须明确前景、中景、后景和空间纵深，确保材质、发光结构、天气、时间和尺度信息可读。",
    "输出形式：同一画面 2×2 网格，从场景中心点平视环视，依次展示前视图、右视图、后视图、左视图；四视图必须是同一个空间，结构、材质、色调和光线逻辑完全一致。",
    "严禁出现任何人物、人影、人体轮廓、手部或剪影。",
    "不要生成灰底产品图、白模图、空白背景或只有单一角度的概念图。",
    "画面中不要有任何文字。",
  ].filter(Boolean);

  return lines.join("\n");
}

export function buildToolAssetPrompt(input: BuildRoleAssetPromptInput) {
  const name = normalizeText(input.name);
  const describe = normalizeText(input.describe);
  const anchors = extractToolPromptAnchors(input.prompt);
  const styleSummary = TOOL_STYLE_SUMMARY[input.artStyle || ""] || "遵循项目既定道具风格，保持结构、材质和功能识别清晰。";

  const lines = [
    styleSummary,
    input.derivative
      ? "道具衍生设定图。必须保留原道具的核心结构、功能和身份锚点，只允许改变当前描述明确提到的状态、损伤、阶段、装配、能量激活或材质变化。"
      : "道具设定图。必须优先遵循道具描述，不要生成模板化通用商品或普通摆件。",
    `道具名称：${name}。`,
    describe ? `核心道具描述：${describe}。` : "",
    anchors.length ? `补充结构锚点：${anchors.join("，")}。` : "",
    "道具描述的优先级高于历史 prompt、通用模板和模型默认习惯，凡是与描述冲突的内容一律不要采用。",
    "必须优先表现用途、结构、材质、纹路、刻痕、装配关系、发光部位或能量核心，保证道具为什么存在、如何工作一眼可读。",
    "如果描述涉及文明遗物、异星材料、符号结构、能量体或超现实器物，不要自动改成普通现代商品模板。",
    "输出形式：同一画面四宫格，展示正面图、侧面图、背面图和细节特写；纯道具静物展示，纯净中性灰底，均匀柔光。",
    "严禁出现人物、手部、肢体、佩戴状态、握持状态或使用中的姿态。",
    "图中不要有任何文字。",
  ].filter(Boolean);

  return lines.join("\n");
}

export function buildAssetPrompt(input: BuildAssetPromptInput) {
  if (input.type === "scene") {
    return buildSceneAssetPrompt(input);
  }
  if (input.type === "tool") {
    return buildToolAssetPrompt(input);
  }
  return buildRoleAssetPrompt(input);
}
