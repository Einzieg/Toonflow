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
const AUTO_REVIEW_DECISION_START = "<!-- TOONFLOW:AUTO_REVIEW_DECISION_FLOW:START -->";
const AUTO_REVIEW_DECISION_END = "<!-- TOONFLOW:AUTO_REVIEW_DECISION_FLOW:END -->";
const AUTO_REVIEW_RESULT_START = "<!-- TOONFLOW:AUTO_REVIEW_RESULT_HANDLING:START -->";
const AUTO_REVIEW_RESULT_END = "<!-- TOONFLOW:AUTO_REVIEW_RESULT_HANDLING:END -->";
const AUTO_REVIEW_SUPERVISION_START = "<!-- TOONFLOW:AUTO_REVIEW_SUPERVISION_RESULT:START -->";
const AUTO_REVIEW_SUPERVISION_END = "<!-- TOONFLOW:AUTO_REVIEW_SUPERVISION_RESULT:END -->";
const DERIVE_ROLE_DEFAULT_START = "<!-- TOONFLOW:DERIVE_ROLE_DEFAULT_COSTUME:START -->";
const DERIVE_ROLE_DEFAULT_END = "<!-- TOONFLOW:DERIVE_ROLE_DEFAULT_COSTUME:END -->";
const STORYBOARD_CLEAR_DECISION_START = "<!-- TOONFLOW:STORYBOARD_CLEAR_DECISION:START -->";
const STORYBOARD_CLEAR_DECISION_END = "<!-- TOONFLOW:STORYBOARD_CLEAR_DECISION:END -->";

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

- 构建或修复分镜表时，必须调用 \`set_storyboard_table\` 工具写入工作区，禁止只输出纯文本表格或只依赖 XML 流式标签。
- 分镜表超过 40 行时必须分块调用：第一块 \`mode=replace\`，后续块 \`mode=append\`；每块都必须从完整行开始、到完整行结束，避免长输出被截断后只保存半张表。
- 最后一块写入后，必须确认工具返回的总行数符合目标分镜数量；不符合时继续补写缺失行，不得返回“已完成”。
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

- 当用户最近一条消息明确要求“重新生成/重写/重做完整分镜面板/重新执行阶段5/重跑阶段5”时，输出任何 \`<storyboardItem>\` 前必须先调用 \`clear_storyboard_panel\`，清空旧分镜面板，禁止把新分镜追加到旧分镜后面。
- 如果用户只是询问原因、排查问题、说“继续”或修复其他环节，不得自行推断需要清空分镜面板。
- 只有用户明确要求“追加/补一条/插入某段分镜”时，才允许不清空并追加写入。
- 阶段5默认调用 \`set_storyboard_panel_from_table\` 结构化写入分镜面板，禁止依赖大段 XML 流式输出；完整重写时先清空再调用该工具，补齐缺失时直接调用该工具跳过已有序号。
- 写入 videoDesc 时，必须按“通用镜头预设与通用推理”补足动作轴：主动作、二级动作、微表情、身体姿态、焦点变化、镜头路径和情绪落点。
- 每条 videoDesc 的时长必须等于 stoaryTable 对应行 duration；内部动作可按“开始/中段/结束”组织，但 XML 字段仍只写当前系统要求的一段文本。
- 写入 prompt 时，仍使用当前系统的 @图N 资产绑定；多角色/多场景/多道具必须逐一引用，不能只保留第一张参考图。
- prompt 负责分镜首帧，videoDesc 负责视频动作；两者冲突时以 stoaryTable 的事实字段为准，prompt 不得覆盖 videoDesc 的动作叙事。
- 长表写入时，每个 storyboardItem 必须完整闭合；允许在同一次回答中按 10-15 条为一组连续输出多组 XML 标签，但禁止空代码块、禁止“后续消息继续”、禁止只返回进度说明。
- 每条 prompt 控制在 500 字以内，每条 videoDesc 控制在 800 字以内；输出量接近上限时优先压缩风格词和画质词，不得省略必填字段。
- 输出仍然只写 storyboardItem XML，不输出 docs/通用推理 的 [开始输出]、=== 或编号行格式。`;

const directorCameraPresets = `## 文档增强：导演镜头预设规划

- 导演规划需要提前给出可执行的镜头运动倾向：静止后轻推、推进/拉远、横移跟拍、升降、环绕、焦点转移、景别变化、手持轻晃或情绪化缓推。
- 对关键镜头规划“主动作 + 二级动作 + 微表情 + 镜头路径 + 情绪落点”，让后续分镜面板能直接生成动态 videoDesc。
- 多资产镜头必须明确角色、场景、道具各自的标准名称，避免别名；后续生成时会映射为 @图N。
- 镜头规划可以描述内部时间推进，但必须保持剧情事实不扩写、不新增未出现资产。`;

const autoReviewDecisionFlow = `### 自动审查模式

**触发条件：**
- 用户明确说“自动审查”“自动推进”“接替用户审查”“自动下一步”“继续完成”“完整制作”等。
- 用户只说“继续/下一步”，且没有要求人工确认时，默认按自动审查模式处理。

**自动审查门禁：**

| 监督层结论 | 决策层操作 |
|------------|-----------|
| \`PASS\` 或评分 A/B | 简要展示审核摘要，立即派发下一阶段 |
| \`AUTO_FIX\` 或评分 C | 提取监督层“自动修复指令”，回派当前阶段执行层修复，修复后重新审核 |
| \`REWORK\` 或评分 D | 回派当前阶段执行层重做，重做后重新审核 |
| \`NEED_USER\` | 停止自动推进，展示必须人工决定的问题 |

**阶段自动推进规则：**
- 阶段1如新增衍生资产，默认自动进入阶段2并生成全部新增衍生资产图片；如执行层明确“不需要衍生资产”，直接进入阶段3。
- 阶段2为异步图片生成，任务启动后无需等待用户确认；除非执行层明确下一阶段依赖已完成图片，否则直接进入阶段3。
- 阶段3执行完成后必须自动审核；A/B 进入阶段4，C/D 自动修复/重做后再审。
- 阶段4执行完成后必须自动审核；A/B 进入阶段5，C/D 自动修复/重做后再审。
- 阶段5多参模式不再询问用户：多参=是时默认使用“分镜图辅助多参模式”；多参=否时使用“首位帧模式”。如果用户明确要求纯文本多参，则按用户要求执行。
- 阶段6启动全部 \`shouldGenerateImage=true\` 分镜图生成后结束自动流程。`;

const autoReviewDecisionResult = `### 自动审查结果处理

阶段3、4的监督层报告必须包含「自动审查结论」。决策层按以下规则执行：

1. \`PASS\`：展示一句审核摘要，立即进入下一阶段。
2. \`AUTO_FIX\`：使用监督层给出的“自动修复指令”回派当前阶段执行层；修复完成后再次调用监督层审核。
3. \`REWORK\`：使用监督层给出的“重做指令”回派当前阶段执行层；重做完成后再次调用监督层审核。
4. \`NEED_USER\`：停止自动推进，展示必须由用户选择的问题。
5. 若监督层未输出明确结论：按评分兜底，A/B=PASS，C=AUTO_FIX，D=REWORK。
6. 同一阶段自动修复/重做最多 2 轮，超过后停止并请求用户决策。`;

const storyboardClearDecisionRules = `### 分镜面板清空规则

- 用户最近一条消息明确要求“清空分镜面板 / 删除分镜面板分镜 / 重新生成分镜面板 / 重写分镜面板 / 重做阶段5 / 重新执行阶段5 / 重跑阶段5”时，决策层必须调用 \`clear_storyboard_panel\` 或派发阶段5时明确要求执行层先调用该工具。
- 若用户已经明确要求清空/重做阶段5，随后最近一条只是“确认 / 继续 / 后续自动推进”，仍视为沿用该清空授权，不得因确认语句丢失授权而跳过清空。
- 完整重新生成阶段5前必须先清空旧分镜面板；否则前端会把新 \`storyboardItem\` 追加到旧分镜后面。
- 仅当用户明确要求“追加分镜 / 插入分镜 / 补一条分镜”时，才允许保留旧分镜并追加。
- 用户只是“排查为什么自动重建/未操作却重新生成”时，属于诊断请求，不是清空授权。
- 清空分镜面板只作用于当前项目和当前剧本，同时清理旧分镜关联、视频轨道和关联视频。`;

const autoReviewSupervisionResult = `### 自动审查结论格式

每次审核报告最前面必须输出以下区块，供决策层自动推进；禁止在输出该区块前展开长篇审核明细：

\`\`\`markdown
## 自动审查结论
- **结论**：PASS / AUTO_FIX / REWORK / NEED_USER
- **评分**：A/B/C/D
- **下一步**：进入阶段X / 修复当前阶段 / 重做当前阶段 / 停止等待用户
- **自动修复指令**：{100字以内；PASS时写“无”}
- **止损原因**：{无 / 必须人工选择的事项}
\`\`\`

### 自动审查判定规则

| 条件 | 结论 | 说明 |
|------|------|------|
| 评分 A | PASS | 可直接进入下一阶段 |
| 评分 B 且无严重问题 | PASS | 小问题不阻断流程；将建议作为后续阶段注意事项 |
| 评分 C 且问题有明确单一路径修复方案 | AUTO_FIX | 输出可直接派发给执行层的修复指令 |
| 评分 D 且主要问题为整体结构错误/大量遗漏 | REWORK | 输出重做当前阶段的指令 |
| 存在多个互斥创作方向、用户偏好必须选择、或无法判断修复方案 | NEED_USER | 停止自动推进，列出必须人工决定的问题 |

自动修复指令必须满足：
- 只包含当前阶段产出物需要修改的内容，不扩展新剧情、不新增资产。
- 指令正文控制在 100 字以内，便于决策层直接派发。
- 如果是分镜表修复，必须明确修复范围（如“补齐缺失台词”“修正不存在的资产ID”“补场景资产ID”）。
- 如果是导演规划修复，必须明确修复维度（如“补齐声音方向”“替换不存在资产引用”“补齐第X场规划”）。`;

const supervisionReportFormat = `### 审核报告格式

\`\`\`markdown
# 审核报告：{审核对象}

## 自动审查结论
- **结论**：PASS / AUTO_FIX / REWORK / NEED_USER
- **评分**：A/B/C/D
- **下一步**：进入阶段X / 修复当前阶段 / 重做当前阶段 / 停止等待用户
- **自动修复指令**：{100字以内；PASS时写“无”}
- **止损原因**：{无 / 必须人工选择的事项}

## 总评
- **概要**：{一句话总评，只写阻断结论}

## 问题清单

| # | 严重程度 | 审核项 | 问题 | 建议方案 |
|---|----------|--------|------|----------|
| 1 | 🔴 严重 | {审核项} | {按范围合并的一句话描述} | {单一路径修复建议} |

## 需要人工决定（仅 NEED_USER 时输出）
1. {必须由用户选择的问题}
\`\`\`

### 精简规则

- 自动审查结论必须出现在报告最前面，避免长输出中断后决策层拿不到结论。
- 审核通过的项目不出现在报告中。
- 同类问题按范围合并，例如“分镜32-41、47-64台词时长不足”，不要逐镜展开完整计算。
- 问题清单最多 12 行；超过 12 行时合并为范围或类别。
- 禁止输出逐镜全量资产映射、逐镜全量字数计算或完整分镜表复述。
- B 级及以上省略「需要人工决定」区块。`;

const deriveRoleDefaultCostumeRules = `## 系统增强：人物默认服装衍生硬约束

- 角色父资产在本系统中默认视为“基础打底态/无服装无姿态底模”，不能直接作为分镜生产的常态角色参考图。
- 每个 \`type=role\` 的父资产，如果当前 \`derive\` 为空，必须至少创建 1 个服装/妆造类衍生资产，作为后续分镜和视频生产的默认出镜形象。
- 默认人物衍生优先级：剧本明确服装 > 资产描述暗示 > 项目题材常态服装。无法判断时创建“常服定装”。
- 该默认衍生只补“完整服装、发型、基础妆造、身份气质”，必须保持自然站立四视图，不创建临时动作、表情、单镜姿态。
- 不得因为“剧本没有明确写服装”而跳过人物默认衍生；父资产是底模时，缺少服装信息本身就是需要补齐的生产缺口。
- 已存在任意人物衍生时不重复补默认衍生；如剧本后续出现礼服、盔甲、破损、异化等稳定状态，再按需追加。`;

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

function replaceSectionBefore(content: string, section: PromptPresetSection, beforeMarker: string, legacyHeading?: string) {
  const nextBlock = `${section.start}\n${section.body.trim()}\n${section.end}`;
  const pattern = new RegExp(`${escapeRegExp(section.start)}[\\s\\S]*?${escapeRegExp(section.end)}`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, nextBlock);
  }

  if (legacyHeading) {
    const legacyIndex = content.indexOf(legacyHeading);
    const markerAfterLegacy = legacyIndex >= 0 ? content.indexOf(beforeMarker, legacyIndex + legacyHeading.length) : -1;
    if (legacyIndex >= 0 && markerAfterLegacy > legacyIndex) {
      return `${content.slice(0, legacyIndex).trimEnd()}\n\n${nextBlock}\n\n${content.slice(markerAfterLegacy).trimStart()}`;
    }
  }

  const markerIndex = content.indexOf(beforeMarker);
  if (markerIndex >= 0) {
    return `${content.slice(0, markerIndex).trimEnd()}\n\n${nextBlock}\n\n${content.slice(markerIndex).trimStart()}`;
  }

  return replaceSection(content, section);
}

function replaceOnce(content: string, search: string, replacement: string) {
  return content.includes(search) ? content.replace(search, replacement) : content;
}

function patchDecisionAgentSkill(content: string) {
  let next = content;

  if (!next.includes("**自动审查优先**")) {
    next = replaceOnce(
      next,
      "- **决策层不做执行层的判断**，执行层返回什么结论就基于该结论决策下一步。",
      "- **决策层不做执行层的判断**，执行层返回什么结论就基于该结论决策下一步。\n- **自动审查优先**：当用户要求“自动审查 / 自动推进 / 继续 / 完整制作 / 接替用户审查”时，进入自动审查模式。自动审查模式下，决策层使用监督层报告替代用户审查，根据评分自动通过、自动修复或止损，不再默认等待用户确认。",
    );
  }

  next = replaceOnce(
    next,
    "- **审核规则**：仅阶段3（导演规划）和阶段4（构建分镜表）需要审核，执行完毕后自动派发监督层",
    "- **审核规则**：仅阶段3（导演规划）和阶段4（构建分镜表）需要审核，执行完毕后自动派发监督层\n- **自动审查止损**：同一阶段最多自动修复 2 轮。连续 2 轮仍为 C/D，或监督层输出 NEED_USER 时，必须停止并向用户展示需要人工决定的问题。",
  );
  next = replaceOnce(
    next,
    '| 衍生资产清单（已写入） | 展示给用户，询问是否生成图片 |',
    '| 衍生资产清单（已写入） | 自动审查模式：默认全部进入阶段2生成图片；人工审查模式：展示给用户并询问是否确认生成图片 |',
  );
  next = replaceOnce(
    next,
    "> 约束：阶段1必须完成衍生资产信息写入，不得仅输出分析文本；需展示给用户确认是否进入图片生成",
    "> 约束：阶段1必须完成衍生资产信息写入；人工审查模式需展示给用户确认是否进入图片生成；自动审查模式默认生成全部新增衍生资产。",
  );
  next = replaceOnce(
    next,
    "| 输入 | 需要生成图片的衍生资产清单（来自用户确认） |",
    "| 输入 | 需要生成图片的衍生资产清单（自动审查模式默认全部新增资产；人工审查模式来自用户确认） |",
  );
  next = replaceOnce(
    next,
    "| 前置条件 | 阶段1完成且用户确认生成 |",
    "| 前置条件 | 阶段1完成且已确定生成清单 |",
  );
  next = replaceOnce(
    next,
    "**决策层行为：** 将用户确认的资产清单（或子集）派发给执行层。返回确认后，告知用户图片生成中，可继续进入阶段3。",
    "**决策层行为：** 将确定的资产清单（或子集）派发给执行层。返回确认后，告知用户图片生成中；自动审查模式直接进入阶段3，人工审查模式询问用户是否进入阶段3。",
  );
  next = replaceOnce(
    next,
    "| 前置条件 | 阶段4完成且用户确认通过审核 |",
    "| 前置条件 | 阶段4完成且已通过审核门禁 |",
  );
  next = replaceOnce(
    next,
    '| 是 | 向用户询问：使用 **"纯文本多参模式"** 还是 **"分镜图辅助多参模式"**，等待用户确认后，将所选模式随任务指令一起派发给执行层 |',
    '| 是 | 自动审查模式默认使用 **"分镜图辅助多参模式"**；人工审查模式向用户询问：使用 **"纯文本多参模式"** 还是 **"分镜图辅助多参模式"**，等待用户确认后，将所选模式随任务指令一起派发给执行层 |',
  );
  next = replaceOnce(
    next,
    "监督层审核完毕后将报告展示给用户。决策层**等待用户回复**，根据用户反馈决定下一步：",
    "监督层审核完毕后将报告展示给用户。若处于自动审查模式，决策层必须读取报告中的「自动审查结论」并立即执行对应动作；若处于人工审查模式，才等待用户回复。",
  );

  next = replaceSectionBefore(
    next,
    { start: AUTO_REVIEW_DECISION_START, end: AUTO_REVIEW_DECISION_END, body: autoReviewDecisionFlow },
    "### 阶段1：衍生资产分析",
    "### 自动审查模式",
  );
  next = replaceSectionBefore(
    next,
    { start: AUTO_REVIEW_RESULT_START, end: AUTO_REVIEW_RESULT_END, body: autoReviewDecisionResult },
    "### 调度决策树",
    "### 自动审查结果处理",
  );
  next = replaceSectionBefore(
    next,
    { start: STORYBOARD_CLEAR_DECISION_START, end: STORYBOARD_CLEAR_DECISION_END, body: storyboardClearDecisionRules },
    "### 调度决策树",
    "### 分镜面板清空规则",
  );

  return next;
}

function patchSupervisionAgentSkill(content: string) {
  let next = content;

  next = replaceOnce(
    next,
    "**核心原则：你负责独立审查，不参与创作执行，只提出问题和建议。**",
    "**核心原则：你负责独立审查并输出可执行结论。人工审查模式下只提出问题和建议；自动审查模式下必须给出可由决策层直接执行的自动审查结论。**",
  );
  next = next.replace(
    /5\. 按「审核报告格式」生成报告(?:，并在报告末尾输出「自动审查结论」)*/g,
    "5. 生成审核报告，必须先输出「自动审查结论」，再输出精简问题摘要；禁止在结论前展开逐镜长篇计算。",
  );

  next = next.replace(/### 审核报告格式[\s\S]*?### 评分标准/, `${supervisionReportFormat}\n\n### 评分标准`);

  return replaceSectionBefore(
    next,
    { start: AUTO_REVIEW_SUPERVISION_START, end: AUTO_REVIEW_SUPERVISION_END, body: autoReviewSupervisionResult },
    "### 审核报告格式",
    "### 自动审查结论格式",
  );
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

function patchSkillFileWithTransform(relativePath: string, transform: (content: string) => string) {
  const filePath = u.getPath(["skills", ...relativePath.split("/")]);
  if (!fs.existsSync(filePath)) return false;

  const current = fs.readFileSync(filePath, "utf-8");
  const next = transform(current);
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
    patchSkillFile("production_execution_derive_assets.md", [
      { start: DERIVE_ROLE_DEFAULT_START, end: DERIVE_ROLE_DEFAULT_END, body: deriveRoleDefaultCostumeRules },
    ]),
    patchSkillFileWithTransform("production_agent_decision.md", patchDecisionAgentSkill),
    patchSkillFileWithTransform("production_agent_supervision.md", patchSupervisionAgentSkill),
  ];

  const changedCount = changes.filter(Boolean).length;
  if (changedCount > 0) {
    console.log(`[fixDB] 已同步 docs 预设提示词增强到生产技能：${changedCount} 个文件`);
  }
}
