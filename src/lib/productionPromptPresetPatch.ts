import fs from "fs";
import u from "@/utils";

type PromptPresetSection = {
  start: string;
  end: string;
  body: string;
};

const SHOT_GROUPING_START = "<!-- TOONFLOW:DOC_SHOT_GROUPING_PRESETS:START -->";
const SHOT_GROUPING_END = "<!-- TOONFLOW:DOC_SHOT_GROUPING_PRESETS:END -->";
const TABLE_EXECUTION_START = "<!-- TOONFLOW:DOC_STORYBOARD_TABLE_EXECUTION:START -->";
const TABLE_EXECUTION_END = "<!-- TOONFLOW:DOC_STORYBOARD_TABLE_EXECUTION:END -->";
const PROMPT_INFERENCE_START = "<!-- TOONFLOW:DOC_PROMPT_INFERENCE_PRESETS:START -->";
const PROMPT_INFERENCE_END = "<!-- TOONFLOW:DOC_PROMPT_INFERENCE_PRESETS:END -->";
const PANEL_EXECUTION_START = "<!-- TOONFLOW:DOC_STORYBOARD_PANEL_EXECUTION:START -->";
const PANEL_EXECUTION_END = "<!-- TOONFLOW:DOC_STORYBOARD_PANEL_EXECUTION:END -->";
const DIRECTOR_PRESET_START = "<!-- TOONFLOW:DOC_DIRECTOR_CAMERA_PRESETS:START -->";
const DIRECTOR_PRESET_END = "<!-- TOONFLOW:DOC_DIRECTOR_CAMERA_PRESETS:END -->";

const shotGroupingPresets = `## 文档增强：分镜拆分预设

来源：docs/分镜/*.md。以下规则用于分镜表拆分与镜头组织，不改变当前分镜表字段格式。

### 通用拆分规则

- 分镜必须完整覆盖原文内容，不跳序、不遗漏、不重复；每段原文只能归属一个分镜。
- 单镜头默认覆盖 1-3 个连续原文单元；动作、情绪、线索、对白转折、场景转换可单独成镜。
- 只合并语义连续、动作空间一致、情绪方向一致的内容；不同地点、不同时间、不同视觉焦点不得强行合并。
- 保留原文叙事顺序和关键台词，不改写剧情因果，不提前泄露后续信息。
- 如果输入原文带有 [时长:Xs]，单个镜头内所有时长累加必须小于 5.0s；该 5 秒红线优先于语义完整和情绪完整。

### 类型化拆分预设

- 默认：按视觉连续性拆分，关键动作和情绪落点单独成镜，平稳铺垫可合并。
- 古风：诗性意境、礼制动作、武侠招式、宫廷权力压迫、人物隐忍微表情、生死抉择优先单独成镜。
- 女频：情绪转折、暧昧拉扯、误会爆发、虐恋反应、甜宠互动、打脸反击、内心独白优先单独成镜。
- 异能：能力觉醒、能量释放、环境破坏、能力对撞、身体反噬、战斗高潮优先单独成镜。
- 悬疑：线索发现、异常惊吓、真相揭露、心理恐惧、推理判断、时间/空间线索优先单独成镜。
- 穿越：身份错位、时代规则冲突、初到陌生环境、知识差异造成的行动、世界观认知转折优先单独成镜。
- 都市：职场/家庭/情感关系变化、现实压力、权力关系、关键谈判、生活细节中的情绪变化优先单独成镜。

### 选择规则

- 根据项目类型、导演手册、剧本文风和剧情关键词选择最贴近的预设；不确定时使用“默认”，并叠加显著类型规则。
- 同一段剧情可叠加多个类型预设，但必须以视觉可拍性和时长约束为最终裁决。`;

const storyboardTableExecution = `## 文档增强：分镜表执行规则

- 激活 storyboard_table_techniques 后，必须应用其中的“文档增强：分镜拆分预设”。
- 构建分镜表前先判断题材预设：默认 / 古风 / 女频 / 异能 / 悬疑 / 穿越 / 都市；判断依据为项目类型、scriptPlan、导演手册和剧本文本。
- 分镜数量由内容密度决定，不为了压缩数量而牺牲关键动作、情绪、线索或对白落点。
- 如果原文包含 [时长:Xs] 标记，拆镜时先按 5 秒红线分组，再填充分镜表字段；没有时长标记时继续使用现有 6 秒黄金规则和表格时长规范。
- 输出仍然必须是当前系统要求的完整分镜表，不输出 docs/分镜 中的 [开始输出]、[N] X-Y、[输出完成] 范围格式。`;

const promptInferencePresets = `## 文档增强：通用镜头预设与通用推理

来源：docs/通用 镜头预设.md、docs/通用 预设.md、docs/通用推理.md。以下规则用于 prompt 与 videoDesc 的推理质量增强，不改变当前 XML / @图N 输出格式。

### 参考图与预设名映射

- 文档中的 **@预设名** 在当前系统中对应实际资产参考图标签 @图N；生成 prompt 时必须继续使用系统已分配的 @图N，不要输出 **@预设名**。
- @图N 必须按 associateAssetsIds 的真实顺序和资产真实类型绑定，不能根据编号大小臆断角色/场景/道具类型。
- 只使用标准资产名称和对应 @图N；禁止输出 @角色库、@物品库、@场景库 或自造别名。
- 多个参考图同时出现时，正文中每个角色、场景、道具都要绑定到各自 @图N，不能只引用一张图替代全部资产。

### 图片 prompt 增强

- 图片 prompt 以分镜首帧为准，必须忠实于分镜表，不把后续动作结果写成已经发生。
- 在不新增剧情元素的前提下，补足 8 个视觉维度：构图、光影、色彩、景深/焦点、材质细节、表情、空间氛围、项目风格。
- 人物表情写到眼神、嘴角、眉眼、肌肉紧张度；身体动作写到手、肩、重心、朝向和空间站位。
- 禁止用泛化质量词替代具体画面；风格词和画质词只能辅助，不能覆盖分镜表的主体、动作和情绪。

### 视频动作推理

- videoDesc / 视频提示词需要从静态分镜推理出主动作、二级动作、微表情、身体运动、焦点变化和情绪弧线。
- 镜头运动优先从以下类型中选择并组合：静止后轻推、推进/拉远、横移/跟拍、升降、环绕、焦点转移、景别变化、手持轻晃、情绪化缓推。
- 单镜头内部应拆成时间段理解，覆盖完整 duration；可使用“起幅状态 -> 中段推进 -> 收束落点”的结构，避免整段只有一句静态描述。
- 时间分段必须服务于动作连续性，不新增未出现的角色、道具、场景、台词或剧情结论。
- 声音、环境、光影只在分镜表已有或逻辑必需时补充，不能喧宾夺主。`;

const storyboardPanelExecution = `## 文档增强：分镜面板执行规则

- 写入 videoDesc 时，必须按“通用镜头预设与通用推理”补足动作轴：主动作、二级动作、微表情、身体姿态、焦点变化、镜头路径和情绪落点。
- 每条 videoDesc 的时长必须等于 stoaryTable 对应行 duration；内部动作可按“开始/中段/结束”组织，但 XML 字段仍只写当前系统要求的一段文本。
- 写入 prompt 时，仍使用当前系统的 @图N 资产绑定；多角色/多场景/多道具必须逐一引用，不能只保留第一张参考图。
- prompt 负责分镜首帧，videoDesc 负责视频动作；两者冲突时以 stoaryTable 的事实字段为准，prompt 不得覆盖 videoDesc 的动作叙事。
- 输出仍然只写 storyboardItem XML，不输出 docs/通用推理 的 [开始输出]、=== 或编号行格式。`;

const directorCameraPresets = `## 文档增强：导演镜头预设规划

- 导演规划需要提前给出可执行的镜头运动倾向：静止后轻推、推进/拉远、横移跟拍、升降、环绕、焦点转移、景别变化、手持轻晃或情绪化缓推。
- 对关键镜头规划“主动作 + 二级动作 + 微表情 + 镜头路径 + 情绪落点”，让后续分镜面板能直接生成动态 videoDesc。
- 多资产镜头必须明确角色、场景、道具各自的标准名称，避免别名；后续生成时会映射为 @图N。
- 镜头规划可以描述内部时间推进，但必须保持剧情事实不扩写、不新增未出现资产。`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceSection(content: string, section: PromptPresetSection) {
  const nextBlock = `${section.start}\n${section.body.trim()}\n${section.end}`;
  const pattern = new RegExp(`${escapeRegExp(section.start)}[\\s\\S]*?${escapeRegExp(section.end)}`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, nextBlock);
  }

  return `${content.trimEnd()}\n\n${nextBlock}\n`;
}

function patchSkillFile(relativePath: string, sections: PromptPresetSection[]) {
  const filePath = u.getPath(["skills", ...relativePath.split("/")]);
  if (!fs.existsSync(filePath)) return false;

  const current = fs.readFileSync(filePath, "utf-8");
  const next = sections.reduce((value, section) => replaceSection(value, section), current);
  if (next === current) return false;

  fs.writeFileSync(filePath, next);
  return true;
}

export async function patchProductionPromptPresetsFromDocs() {
  const changes = [
    patchSkillFile("production_skills/storyboard_table_techniques.md", [
      { start: SHOT_GROUPING_START, end: SHOT_GROUPING_END, body: shotGroupingPresets },
    ]),
    patchSkillFile("production_execution_storyboard_table.md", [
      { start: TABLE_EXECUTION_START, end: TABLE_EXECUTION_END, body: storyboardTableExecution },
    ]),
    patchSkillFile("production_skills/storyboard_prompt_techniques.md", [
      { start: PROMPT_INFERENCE_START, end: PROMPT_INFERENCE_END, body: promptInferencePresets },
    ]),
    patchSkillFile("production_execution_storyboard_panel.md", [
      { start: PANEL_EXECUTION_START, end: PANEL_EXECUTION_END, body: storyboardPanelExecution },
    ]),
    patchSkillFile("production_execution_director_plan.md", [
      { start: DIRECTOR_PRESET_START, end: DIRECTOR_PRESET_END, body: directorCameraPresets },
    ]),
  ];

  const changedCount = changes.filter(Boolean).length;
  if (changedCount > 0) {
    console.log(`[fixDB] 已同步 docs 预设提示词增强到生产技能：${changedCount} 个文件`);
  }
}
