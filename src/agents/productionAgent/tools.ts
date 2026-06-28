import { tool, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import {
  expandStoryboardItemsForDuration,
  getPlannedStoryboardTrackStorageValue,
  planStoryboardTrackSegments,
  resolveStoryboardTrackTargetDuration,
} from "@/utils/storyboardTrack";
import { normalizeStoryboardAssociateAssets, type StoryboardAssetProjectAsset } from "@/utils/storyboardAssetRefs";
import { generateStoryboardImagePromptWithAI } from "@/utils/storyboardImagePrompt";
import { resolveStoryboardPanelMode } from "@/utils/storyboardPanelMode";
import { ensureStoryboardTracks } from "@/utils/storyboardPanelSync";
import { normalizeStoryboardShotMeta } from "@/utils/storyboardShotMeta";
import {
  buildCurrentShotPlanFingerprint,
  buildShotPlanFingerprint,
  BeatSchema,
  findShotPlanStaleReasons,
  getRelevantProjectAssets,
  renderStoryboardTableFromShotPlan,
  ShotSchema,
  type ShotPlan,
  ShotPlanInputSchema,
  ShotPlanSchema,
  validateShotPlanAssets,
  validateShotPlanStructure,
} from "@/utils/shotPlan";
import {
  SHOT_POLICY_VERSION,
  resolveAllowedShotDurationSeconds,
  resolveMaxShotDurationSeconds,
  resolveMinShotDurationSeconds,
  type ShotPolicyContext,
} from "@/utils/shotPolicy";
import {
  clearStoryboardFirstWorkflow,
  getStoryboardFirstState,
  startGenerateStoryboardFirstImage,
  startGenerateStoryboardFirstScript,
  startGenerateStoryboardFirstVideo,
  updateStoryboardFirstScript,
} from "@/utils/storyboardFirst";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  volcengineAssetUri: z.string().nullable().optional().describe("火山引擎官方虚拟人像URI，仅真人/角色视频生成阶段使用"),
  voiceProfile: z.string().nullable().optional().describe("角色声线设定，仅role使用，如低沉磁性、清亮少年感"),
  voiceTone: z.string().nullable().optional().describe("角色语气设定，仅role使用，如克制冷静、温柔坚定、急促紧张"),
  speechRate: z.string().nullable().optional().describe("角色语速设定，仅role使用，如慢速、正常、偏快"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  volcengineAssetUri: z.string().nullable().optional().describe("火山引擎官方虚拟人像URI，仅真人/角色视频生成阶段使用"),
  voiceProfile: z.string().nullable().optional().describe("角色声线设定，仅role使用，如低沉磁性、清亮少年感"),
  voiceTone: z.string().nullable().optional().describe("角色语气设定，仅role使用，如克制冷静、温柔坚定、急促紧张"),
  speechRate: z.string().nullable().optional().describe("角色语速设定，仅role使用，如慢速、正常、偏快"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).optional().describe("分镜图片生成状态"),
  shouldGenerateImage: z.number().optional().describe("是否需要生成分镜图，1为需要"),
  track: z.string().nullable().optional().describe("分镜所属轨道分组"),
  videoDesc: z.string().optional().describe("分镜画面描述"),
  shotMeta: z.any().optional().describe("Agent 生成的台词字数、估算语速和时长依据"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  shotPlan: z.any().nullable().optional().describe("镜头规划"),
  shotPolicy: z.any().nullable().optional().describe("当前项目视频模型的分镜时长策略"),
  targetDuration: z.number().nullable().optional().describe("目标总时长，秒"),
  targetDurationSource: z.string().nullable().optional().describe("目标时长来源"),
  scriptTargetDuration: z.number().nullable().optional().describe("剧本声明的参考时长，秒"),
  scriptTargetDurationSource: z.string().nullable().optional().describe("剧本参考时长来源"),
  scriptTargetDurationRaw: z.string().nullable().optional().describe("剧本参考时长原始文本"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ParsedStoryboardTableRow {
  no: number;
  description: string;
  scene: string;
  assetNames: string;
  duration: number;
  shot: string;
  camera: string;
  action: string;
  emotion: string;
  lighting: string;
  dialogue: string;
  sound: string;
  associateAssetsIds: number[];
  shotMeta?: Record<string, any> | null;
}

type ExpandedStoryboardTableRow = ParsedStoryboardTableRow & {
  expandedIndex: number;
  originalDuration: number;
  splitIndex: number;
  splitCount: number;
};

const FLOW_DATA_SOCKET_TIMEOUT_MS = 5000;
const STORYBOARD_PANEL_WRITE_BATCH_SIZE = 10;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

function normalizeUserCommand(content: string) {
  return String(content || "").replace(/\s+/g, "");
}

function isExplicitStoryboardClearRequest(content: string) {
  const text = normalizeUserCommand(content);
  if (!text) return false;

  const isInvestigationOnly = /(为什么|为何|怎么会|怎么又|排查|查一下|看下|原因|问题|未操作|没操作|没有操作|自动|情况)/.test(text);
  const investigationWords = "为什么|为何|怎么|排查|查一下|看下|原因|问题|情况|未操作|没操作|没有操作|自动";
  const destructiveWords = "清空|删除|删掉|移除|重置|重做|重写|重新生成|重新制作|重新执行|重新跑|重跑|从头";
  const directDestructiveIntent =
    new RegExp(
      `(帮我|请|需要|我要|我想|先|直接|现在|把|将)(?:(?!${investigationWords}).){0,12}(${destructiveWords})`,
    ).test(
      text,
    ) || new RegExp(`^(${destructiveWords})`).test(text);
  const mentionsStoryboardClear =
    new RegExp(`(${destructiveWords}).{0,16}(分镜面板|分镜|阶段5)`).test(text) ||
    new RegExp(`(分镜面板|分镜|阶段5).{0,16}(${destructiveWords})`).test(text);

  if (isInvestigationOnly && !directDestructiveIntent) return false;
  return directDestructiveIntent && mentionsStoryboardClear;
}

function isStoryboardClearConfirmation(content: string) {
  const text = normalizeUserCommand(content);
  return /(确认|同意|可以|继续|执行|开始|后续自动推进|自动推进|按这个|就这样)/.test(text);
}

function hasRecentStoryboardClearAuthorization(messages: Array<{ content: string; createTime: number }>) {
  const [latest] = messages;
  if (!latest) return false;
  if (isExplicitStoryboardClearRequest(latest.content)) return true;
  if (!isStoryboardClearConfirmation(latest.content)) return false;

  const latestTime = Number(latest.createTime || Date.now());
  const authorizationWindowMs = 6 * 60 * 60 * 1000;
  return messages.slice(1).some((message) => {
    const messageTime = Number(message.createTime || 0);
    return latestTime - messageTime <= authorizationWindowMs && isExplicitStoryboardClearRequest(message.content);
  });
}

function isStoryboardFirstRequest(content: string) {
  const text = normalizeUserCommand(content);
  return /(故事板先行|先出故事板|从剧本生成故事板图片|故事板转视频|单图故事板)/.test(text);
}

function truncateText(value: string, maxLength: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatStoryboardPanelBatchRanges(rows: Array<{ no: number }>, batchSize = STORYBOARD_PANEL_WRITE_BATCH_SIZE) {
  const shotNumbers = Array.from(new Set(rows.map((row) => Number(row.no)).filter((no) => Number.isInteger(no) && no > 0))).sort(
    (a, b) => a - b,
  );
  if (!shotNumbers.length) return "";

  const ranges: Array<{ start: number; end: number }> = [];
  let start = shotNumbers[0];
  let previous = shotNumbers[0];
  let count = 1;

  for (const shotNo of shotNumbers.slice(1)) {
    if (count >= batchSize || shotNo !== previous + 1) {
      ranges.push({ start, end: previous });
      start = shotNo;
      count = 1;
    } else {
      count += 1;
    }
    previous = shotNo;
  }
  ranges.push({ start, end: previous });

  return ranges
    .map(
      ({ start: rangeStart, end: rangeEnd }) =>
        `set_storyboard_panel_from_table({ "mode": "auto", "startNo": ${rangeStart}, "endNo": ${rangeEnd} })`,
    )
    .join("\n");
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseAssetIds(value: string) {
  return Array.from(new Set((value.match(/\d+/g) ?? []).map(Number).filter((id) => Number.isInteger(id))));
}

function normalizeTableHeader(value: string) {
  return String(value || "").replace(/\s+/g, "").replace(/[（）()]/g, "").trim();
}

function isMarkdownSeparatorRow(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function hasHeaderCell(headers: string[] | null, aliases: string[]) {
  if (!headers?.length) return false;
  const normalizedAliases = aliases.map(normalizeTableHeader);
  return headers.some((header) => normalizedAliases.includes(normalizeTableHeader(header)));
}

function getHeaderCell(cells: string[], headers: string[] | null, aliases: string[]) {
  if (!headers?.length) return "";
  const normalizedAliases = aliases.map(normalizeTableHeader);
  const index = headers.findIndex((header) => normalizedAliases.includes(normalizeTableHeader(header)));
  return index >= 0 ? cells[index] ?? "" : "";
}

const REQUIRED_STORYBOARD_TABLE_HEADERS = [
  ["序号", "编号"],
  ["画面描述", "画面", "画面内容"],
  ["场景", "场景名"],
  ["资产", "引用资产名称", "关联资产名称", "参演角色"],
  ["时长", "持续时长"],
  ["景别"],
  ["运镜", "镜头运动"],
  ["动作", "角色动作", "动作目标"],
  ["情绪", "情绪基调"],
  ["光影", "光影氛围"],
  ["台词", "对白"],
  ["音效", "声音"],
  ["关联资产ID", "引用资产ID", "资产ID"],
];

function hasRequiredStoryboardTableHeaders(headers: string[]) {
  return REQUIRED_STORYBOARD_TABLE_HEADERS.every((aliases) => hasHeaderCell(headers, aliases));
}

function normalizeStoryboardTableRow(row: ParsedStoryboardTableRow): ParsedStoryboardTableRow {
  return {
    ...row,
    description: row.description.trim(),
    scene: row.scene.trim(),
    assetNames: row.assetNames.trim(),
    shot: row.shot.trim(),
    camera: row.camera.trim(),
    action: row.action.trim() || row.description.trim(),
    emotion: row.emotion.trim() || "未指定",
    lighting: row.lighting.trim() || "未指定",
    dialogue: row.dialogue.trim() || "无台词",
    sound: row.sound.trim() || "无音效",
    associateAssetsIds: Array.from(new Set(row.associateAssetsIds.filter((id) => Number.isInteger(id)))),
  };
}

function buildShotTimingMeta(shot: ShotPlan["shots"][number]) {
  return normalizeStoryboardShotMeta(
    {
      estimatedSpeechRate: shot.estimatedSpeechRate ?? null,
      estimatedSpeechDuration: shot.estimatedSpeechDuration ?? null,
      durationReason: shot.durationReason ?? shot.splitReason ?? "",
      durationReasonSource: shot.durationReasonSource ?? "unknown",
    },
    {
      dialogue: shot.dialogue,
      duration: shot.duration,
      sourceShotNo: shot.shotNo,
    },
  );
}

function parseStoredShotMeta(value: unknown) {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, any>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStoredShotMeta(value: unknown, input: { videoDesc?: string | null; duration?: number | string | null; sourceShotNo?: number | string | null }) {
  const parsed = parseStoredShotMeta(value);
  if (!parsed) return null;
  return normalizeStoryboardShotMeta(parsed, input);
}

function buildShotTimingMetaFromRow(row: ParsedStoryboardTableRow | ExpandedStoryboardTableRow) {
  return normalizeStoryboardShotMeta(row.shotMeta ?? {}, {
    dialogue: row.dialogue,
    duration: row.duration,
    sourceShotNo: row.no,
  });
}

function materializeStoryboardRowsFromShotPlan(shotPlan: ShotPlan): ParsedStoryboardTableRow[] {
  return [...shotPlan.shots]
    .sort((a, b) => Number(a.shotNo) - Number(b.shotNo))
    .map((shot) =>
      normalizeStoryboardTableRow({
        no: Number(shot.shotNo),
        description: shot.visualObjective,
        scene: shot.scene,
        assetNames: shot.assetNames || shot.characters.join("、"),
        duration: Number(shot.duration) || 0,
        shot: shot.shotSize,
        camera: shot.cameraMove,
        action: shot.actionUnit,
        emotion: shot.emotion,
        lighting: shot.lighting,
        dialogue: shot.dialogue,
        sound: shot.sound,
        associateAssetsIds: shot.associateAssetsIds || [],
        shotMeta: buildShotTimingMeta(shot),
      }),
    );
}

function summarizeFlowDataValue(key: keyof FlowData, value: unknown) {
  const label = flowDataKeyLabels[key] || key;
  if (typeof value === "string") {
    const preview = value.length > 500 ? `${value.slice(0, 500)}...` : value;
    return `${label}类型：文本；长度：${value.length} 字符${preview ? `；预览：\n${preview}` : ""}`;
  }

  if (Array.isArray(value)) {
    const sample = value.slice(0, 5).map((item: any) => {
      if (item && typeof item === "object") {
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          state: item.state,
          deriveCount: Array.isArray(item.derive) ? item.derive.length : undefined,
        };
      }
      return item;
    });
    return `${label}类型：数组；数量：${value.length}；样例：${JSON.stringify(sample)}`;
  }

  if (value && typeof value === "object") {
    const data = value as Record<string, any>;
    const summary: Record<string, any> = { keys: Object.keys(data).slice(0, 20) };
    if (Array.isArray(data.beats)) summary.beatCount = data.beats.length;
    if (Array.isArray(data.shots)) summary.shotCount = data.shots.length;
    if (data.targetDuration != null) summary.targetDuration = data.targetDuration;
    if (data.totalEstimatedDuration != null) summary.totalEstimatedDuration = data.totalEstimatedDuration;
    return `${label}类型：对象；摘要：${JSON.stringify(summary)}`;
  }

  return `${label}值：${String(value ?? "")}`;
}

function parseStoryboardTableRows(content: string): ParsedStoryboardTableRow[] {
  const rows: ParsedStoryboardTableRow[] = [];
  let currentHeaders: string[] | null = null;

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!line.startsWith("|")) continue;
    const cells = splitMarkdownTableRow(line);
    if (isMarkdownSeparatorRow(cells)) continue;

    const maybeHeader = cells.some((cell) => ["序号", "编号"].includes(normalizeTableHeader(cell))) && cells.some((cell) => normalizeTableHeader(cell).includes("画面"));
    if (maybeHeader) {
      currentHeaders = hasRequiredStoryboardTableHeaders(cells) ? cells : null;
      continue;
    }
    if (!currentHeaders) continue;

    const no = Number(getHeaderCell(cells, currentHeaders, ["序号", "编号"]));
    if (!Number.isInteger(no)) continue;

    const durationText = getHeaderCell(cells, currentHeaders, ["时长", "持续时长"]);
    const duration = Number(String(durationText).match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
    const description = getHeaderCell(cells, currentHeaders, ["画面描述", "画面", "画面内容"]);
    const scene = getHeaderCell(cells, currentHeaders, ["场景", "场景名"]);
    const assetNames = getHeaderCell(cells, currentHeaders, ["资产", "引用资产名称", "关联资产名称", "参演角色"]);
    const shot = getHeaderCell(cells, currentHeaders, ["景别"]);
    const camera = getHeaderCell(cells, currentHeaders, ["运镜", "镜头运动"]);
    const action = getHeaderCell(cells, currentHeaders, ["动作", "角色动作", "动作目标"]);
    const emotion = getHeaderCell(cells, currentHeaders, ["情绪", "情绪基调"]);
    const lighting = getHeaderCell(cells, currentHeaders, ["光影", "光影氛围"]);
    const dialogue = getHeaderCell(cells, currentHeaders, ["台词", "对白"]);
    const sound = getHeaderCell(cells, currentHeaders, ["音效", "声音"]);
    const assetIdsText = getHeaderCell(cells, currentHeaders, ["关联资产ID", "引用资产ID", "资产ID"]);
    const parsedAssetIds = parseAssetIds(assetIdsText);

    rows.push(
      normalizeStoryboardTableRow({
        no,
        description,
        scene,
        assetNames,
        duration,
        shot,
        camera,
        action,
        emotion,
        lighting,
        dialogue,
        sound,
        associateAssetsIds: parsedAssetIds,
      }),
    );
  }

  return rows;
}

function validateStoryboardTableRows(
  rows: ParsedStoryboardTableRow[],
  targetDuration?: number | null,
  options: { requireCompleteTable?: boolean } = {},
  policyContext?: ShotPolicyContext | null,
) {
  const violations: string[] = [];
  const minShotDuration = resolveMinShotDurationSeconds(policyContext);
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);

  if (!rows.length) {
    violations.push("分镜表为空");
    return violations;
  }

  for (const row of rows) {
    if (!row.description.trim()) violations.push(`分镜 ${row.no} 缺少画面描述`);
    if (!row.action.trim()) violations.push(`分镜 ${row.no} 缺少动作目标`);
    if (!row.shot.trim()) violations.push(`分镜 ${row.no} 缺少景别`);
    if (!row.camera.trim()) violations.push(`分镜 ${row.no} 缺少运镜`);
    if (!Number.isFinite(row.duration) || row.duration <= 0) violations.push(`分镜 ${row.no} 时长无效`);
    else if (row.duration < minShotDuration) violations.push(`分镜 ${row.no} 时长 ${row.duration}s 过短，低于 ${minShotDuration}s`);
    else if (row.duration > maxShotDuration) {
      violations.push(`分镜 ${row.no} 时长 ${row.duration}s 过长，必须按当前视频模型拆分到 ${maxShotDuration}s 以内`);
    }
  }

  return violations;
}

function expandStoryboardTableRows(rows: ParsedStoryboardTableRow[]): ExpandedStoryboardTableRow[] {
  let expandedIndex = 0;
  return rows.flatMap((row) => {
    const chunks = expandStoryboardItemsForDuration([row]);
    return chunks.map((chunk, splitIndex) => ({
      ...row,
      duration: chunk.duration,
      expandedIndex: expandedIndex++,
      originalDuration: row.duration,
      splitIndex,
      splitCount: chunks.length,
    }));
  });
}

function buildStoryboardVideoDesc(row: ParsedStoryboardTableRow | ExpandedStoryboardTableRow) {
  return truncateText(
    [
      `【画面】${row.description}`,
      `【场景】${row.scene}`,
      `【镜头】${row.shot}，${row.camera}`,
      `【动作】${row.action}`,
      `【情绪】${row.emotion}`,
      `【光影】${row.lighting}`,
      row.dialogue && row.dialogue !== "无台词" ? `【台词】${row.dialogue}` : "",
      row.sound && row.sound !== "无音效" ? `【音效】${row.sound}` : "",
      `【关联资产ID】[${row.associateAssetsIds.join(", ")}]`,
      "splitCount" in row && row.splitCount > 1
        ? `【时长拆分】原分镜 ${row.originalDuration}s，第 ${row.splitIndex + 1}/${row.splitCount} 段，本段 ${row.duration}s`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    800,
  );
}

async function buildStoryboardPrompt(
  row: ParsedStoryboardTableRow,
  assetMap: Map<number, StoryboardAssetProjectAsset>,
  artStyle?: string | null,
  projectId?: number | null,
) {
  const assets = row.associateAssetsIds.map((assetId) => assetMap.get(assetId) ?? { id: assetId, name: `资产${assetId}`, type: "role" });
  return generateStoryboardImagePromptWithAI({
    fields: row,
    assets,
    artStyle,
    projectId,
    fallbackOnError: false,
  });
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const flowDataValueCache = new Map<keyof FlowData, unknown>();
  const invalidateFlowDataCache = (...keys: (keyof FlowData)[]) => {
    if (!keys.length) {
      flowDataValueCache.clear();
      return;
    }
    keys.forEach((key) => flowDataValueCache.delete(key));
  };
  const getRecentUserMessages = async () => {
    const { projectId, scriptId } = resTool.data;
    const isolationKey = `${projectId}:productionAgent:${scriptId}`;
    const rows = await u
      .db("memories")
      .where({ isolationKey, type: "message", role: "user" })
      .orderBy("createTime", "desc")
      .limit(8);
    return rows.map((row: any) => ({
      content: String(row?.content ?? ""),
      createTime: Number(row?.createTime ?? 0),
    }));
  };
  const latestUserMessageText = async () => (await getRecentUserMessages())[0]?.content ?? "";
  const shouldBlockStoryboardPanelTool = async () => isStoryboardFirstRequest(await latestUserMessageText());
  const blockStoryboardPanelTool = (thinking: ReturnType<typeof msg.thinking>, toolName: string) => {
    thinking.updateTitle("工具调用已拦截");
    thinking.appendText(`${toolName} 属于分镜面板流程，但最近用户消息处于“故事板先行”语境，应改用 storyboard_first 工具。`);
    thinking.complete();
    return "已拦截：当前是故事板先行工作流，请使用 get_storyboard_first_state / generate_storyboard_first_script / generate_storyboard_first_image / generate_storyboard_first_video / clear_storyboard_first_workflow。";
  };
  const finishToolReturn = (
    thinking: ReturnType<typeof msg.thinking>,
    title: string,
    body: string,
    returnValue: string | Record<string, any>,
  ) => {
    thinking.updateTitle(title);
    if (body) thinking.appendText(body);
    thinking.complete();
    return returnValue;
  };
  const getAgentWorkData = async () => {
    const { projectId, scriptId } = resTool.data;
    const existing = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .where("episodesId", String(scriptId))
      .where("key", "productionAgent")
      .first();
    let data: Record<string, any> = {};

    if (existing?.data) {
      try {
        data = JSON.parse(existing.data);
      } catch {
        data = {};
      }
    }

    if (!data.script) {
      const scriptData = await u.db("o_script").where("id", scriptId).select("content").first();
      data.script = scriptData?.content ?? "";
    }
    if (data.shotPlan === undefined) data.shotPlan = null;
    if (data.shotPolicy === undefined) data.shotPolicy = null;
    if (data.targetDuration === undefined) data.targetDuration = null;
    if (data.targetDurationSource === undefined) data.targetDurationSource = null;
    if (data.scriptTargetDuration === undefined) data.scriptTargetDuration = null;
    if (data.scriptTargetDurationSource === undefined) data.scriptTargetDurationSource = null;
    if (data.scriptTargetDurationRaw === undefined) data.scriptTargetDurationRaw = null;
    if (!Array.isArray(data.storyboard)) data.storyboard = [];
    if (!data.workbench) data.workbench = { videoList: [] };

    return { existing, data };
  };
  const saveAgentWorkData = async (existing: any, data: Record<string, any>) => {
    const { projectId, scriptId } = resTool.data;
    if (existing) {
      await u
        .db("o_agentWorkData")
        .where("projectId", String(projectId))
        .where("episodesId", String(scriptId))
        .where("key", "productionAgent")
        .update({ data: JSON.stringify(data), updateTime: Date.now() });
    } else {
      await u.db("o_agentWorkData").insert({
        projectId,
        episodesId: scriptId,
        key: "productionAgent",
        data: JSON.stringify(data),
        createTime: Date.now(),
        updateTime: Date.now(),
      });
    }
    invalidateFlowDataCache();
  };
  const getServerStoryboardPanelData = async (): Promise<FlowData["storyboard"]> => {
    const { projectId, scriptId } = resTool.data;
    if (!projectId || !scriptId) return [];
    const repairResult = await ensureStoryboardTracks(projectId, scriptId);
    if (repairResult.synced) {
      console.log(
        `[productionAgent.get_flowData.storyboard] repaired tracks projectId=${projectId} scriptId=${scriptId} storyboardCount=${repairResult.storyboardCount} trackCount=${repairResult.trackCount}`,
      );
    }

    const storyboardRows = await u
      .db("o_storyboard")
      .where({ projectId, scriptId })
      .orderBy("index", "asc")
      .select("id", "duration", "prompt", "filePath", "index", "state", "shouldGenerateImage", "track", "trackId", "videoDesc", "shotMeta");

    const storyboardIds = storyboardRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
    const assetRows = storyboardIds.length
      ? await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).orderBy("storyboardId", "asc").orderBy("rowid", "asc")
      : [];
    const assetIdsByStoryboard = new Map<number, number[]>();
    for (const row of assetRows) {
      const storyboardId = Number(row.storyboardId);
      const assetId = Number(row.assetId);
      if (!Number.isInteger(storyboardId) || !Number.isInteger(assetId)) continue;
      const list = assetIdsByStoryboard.get(storyboardId) ?? [];
      list.push(assetId);
      assetIdsByStoryboard.set(storyboardId, list);
    }

    return storyboardRows.map((item: any) => {
      const storyboardId = Number(item.id);
      return {
        id: storyboardId,
        duration: Number(item.duration) || 0,
        prompt: item.prompt ?? "",
        associateAssetsIds: assetIdsByStoryboard.get(storyboardId) ?? [],
        src: item.filePath ?? null,
        index: item.index ?? null,
        state: item.state ?? undefined,
        shouldGenerateImage: Number(item.shouldGenerateImage ?? 0),
        track: item.track ?? null,
        trackId: item.trackId ?? null,
        videoDesc: item.videoDesc ?? "",
        shotMeta: normalizeStoredShotMeta(item.shotMeta, {
          videoDesc: item.videoDesc,
          duration: item.duration,
          sourceShotNo: item.index != null ? Number(item.index) + 1 : null,
        }),
      };
    });
  };
  const getServerFlowDataValue = async (key: keyof FlowData) => {
    const { projectId, scriptId } = resTool.data;
    const { data } = await getAgentWorkData();

    if (key === "script") {
      const scriptData = await u.db("o_script").where({ id: scriptId, projectId }).select("content").first();
      return scriptData?.content ?? data.script ?? "";
    }

    if (key === "assets" && !Array.isArray(data.assets)) {
      const scriptAssets = await u.db("o_scriptAssets").where("scriptId", scriptId).select("assetId");
      const assetIds = scriptAssets.map((item: any) => Number(item.assetId)).filter((id) => Number.isInteger(id));
      if (!assetIds.length) return [];
      const assets = await u
        .db("o_assets")
        .where("projectId", projectId)
        .whereIn("id", assetIds)
        .select("id", "name", "type", "prompt", "describe", "volcengineAssetUri", "voiceProfile", "voiceTone", "speechRate", "state", "assetsId");
      const childAssets = await u
        .db("o_assets")
        .where("projectId", projectId)
        .whereIn("assetsId", assetIds)
        .select("id", "assetsId", "name", "type", "prompt", "describe", "volcengineAssetUri", "voiceProfile", "voiceTone", "speechRate", "state");
      return assets.map((asset: any) => ({
        id: asset.id,
        name: asset.name ?? "",
        type: asset.type ?? "",
        prompt: asset.prompt ?? "",
        desc: asset.describe ?? "",
        volcengineAssetUri: asset.volcengineAssetUri ?? null,
        voiceProfile: asset.voiceProfile ?? null,
        voiceTone: asset.voiceTone ?? null,
        speechRate: asset.speechRate ?? null,
        state: asset.state ?? "未生成",
        derive: childAssets
          .filter((child: any) => Number(child.assetsId) === Number(asset.id))
          .map((child: any) => ({
            id: child.id,
            assetsId: child.assetsId,
            name: child.name ?? "",
            type: child.type ?? "",
            prompt: child.prompt ?? "",
            desc: child.describe ?? "",
            volcengineAssetUri: child.volcengineAssetUri ?? asset.volcengineAssetUri ?? null,
            voiceProfile: child.voiceProfile ?? asset.voiceProfile ?? null,
            voiceTone: child.voiceTone ?? asset.voiceTone ?? null,
            speechRate: child.speechRate ?? asset.speechRate ?? null,
            state: child.state ?? "未生成",
          })),
      }));
    }

    if (key === "storyboard") {
      return await getServerStoryboardPanelData();
    }

    if (key === "shotPolicy") {
      const projectData = await u.db("o_project").where("id", projectId).select("videoModel").first();
      const modelDetail = await getProjectVideoModelDetail(projectData);
      return buildShotPolicyDescriptor(projectData, modelDetail);
    }

    return data[key] ?? (key === "assets" ? [] : "");
  };
  const getClientFlowDataValue = async (key: keyof FlowData) => {
    return await new Promise<unknown>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      }, FLOW_DATA_SOCKET_TIMEOUT_MS);

      socket.emit("getFlowData", { key }, (res: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res?.[key]);
      });
    });
  };
  const getFlowDataValue = async (key: keyof FlowData) => {
    const shouldUseServerAuthoritativeValue = key === "storyboard";
    const shouldBypassCache = shouldUseServerAuthoritativeValue;

    if (!shouldBypassCache && flowDataValueCache.has(key)) {
      return {
        source: "本轮缓存",
        value: flowDataValueCache.get(key),
      };
    }

    const clientValue = await getClientFlowDataValue(key);
    const source = shouldUseServerAuthoritativeValue ? "服务端数据库" : clientValue === undefined ? "服务端兜底" : "前端工作区";
    const value = shouldUseServerAuthoritativeValue || clientValue === undefined ? await getServerFlowDataValue(key) : clientValue;
    if (key === "storyboard" && Array.isArray(value) && Array.isArray(clientValue) && value.length !== clientValue.length) {
      await emitClientEvent("setStoryboardPanel", {
        projectId: resTool.data.projectId,
        scriptId: resTool.data.scriptId,
        totalCount: value.length,
        reason: "get_flowData_resync",
      });
    }
    if (shouldBypassCache) {
      flowDataValueCache.delete(key);
    } else {
      flowDataValueCache.set(key, value);
    }
    return { source, value };
  };
  const syncStoryboardTracks = async (projectId: number, scriptId: number) => {
    const [storyboardRows, projectData] = await Promise.all([
      u
        .db("o_storyboard")
        .where({ projectId, scriptId })
        .orderBy("index", "asc")
        .select("id", "index", "track", "trackId", "duration", "videoDesc"),
      u.db("o_project").where("id", projectId).select("videoModel").first(),
    ]);

    const modelDetail = await getProjectVideoModelDetail(projectData);
    const trackTargetDuration = resolveStoryboardTrackTargetDuration(projectData?.videoModel, modelDetail?.name || modelDetail?.modelName, modelDetail?.durationResolutionMap);
    const plannedSegments = planStoryboardTrackSegments(storyboardRows, trackTargetDuration);
    const reusedTrackIds = new Set<number>();
    const originalStoryboardIdsByTrackId = new Map<number, Set<number>>();
    storyboardRows.forEach((row: any) => {
      const trackId = Number(row.trackId);
      const storyboardId = Number(row.id);
      if (!Number.isInteger(trackId) || !Number.isInteger(storyboardId)) return;
      const storyboardIds = originalStoryboardIdsByTrackId.get(trackId) ?? new Set<number>();
      storyboardIds.add(storyboardId);
      originalStoryboardIdsByTrackId.set(trackId, storyboardIds);
    });

    for (const segment of plannedSegments) {
      const storyboardIds = segment.items.map((item) => item.id).filter((id): id is number => id != null);
      if (!storyboardIds.length) continue;
      const trackStorageValue = getPlannedStoryboardTrackStorageValue(segment);

      const candidateTrackId =
        segment.items
          .map((item) => item.trackId)
          .find((trackId): trackId is number => trackId != null && !reusedTrackIds.has(trackId)) ?? null;

      let trackId = candidateTrackId;
      if (trackId == null) {
        const [newTrackId] = await u.db("o_videoTrack").insert({
          scriptId,
          projectId,
          duration: segment.duration,
        });
        trackId = newTrackId;
      } else {
        const originalStoryboardIds = originalStoryboardIdsByTrackId.get(trackId);
        const segmentStoryboardIdSet = new Set(storyboardIds.map(Number));
        const trackMembershipChanged =
          originalStoryboardIds != null &&
          (originalStoryboardIds.size !== segmentStoryboardIdSet.size || [...originalStoryboardIds].some((id) => !segmentStoryboardIdSet.has(id)));
        const membershipChanged = trackMembershipChanged || segment.items.some((item) => item.trackId !== trackId || String(item.track ?? "") !== trackStorageValue);
        await u
          .db("o_videoTrack")
          .where("id", trackId)
          .update({
            duration: segment.duration,
            ...(membershipChanged
              ? {
                  prompt: "",
                  reason: null,
                  state: null,
                  videoId: null,
                  selectVideoId: null,
                }
              : {}),
          });
      }

      reusedTrackIds.add(trackId);
      await u.db("o_storyboard").whereIn("id", storyboardIds).update({
        trackId,
        track: trackStorageValue,
      });
    }

    const existingTrackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
    const staleTrackIds = existingTrackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id) && !reusedTrackIds.has(id));
    if (staleTrackIds.length) {
      const trackIdsWithVideos = new Set(
        (await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", staleTrackIds).select("videoTrackId")).map((item: any) =>
          Number(item.videoTrackId),
        ),
      );
      const emptyStaleTrackIds = staleTrackIds.filter((trackId) => !trackIdsWithVideos.has(trackId));
      if (emptyStaleTrackIds.length) {
        await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", emptyStaleTrackIds).del();
      }
    }

    // Track grouping must not change image generation intent. Grok single-image
    // video generation chooses one reference at request time instead of marking
    // the remaining storyboard frames as "do not generate" in the panel.
  };
  const storyboardGenerateInputSchema = z.object({
    ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
  });
  const executeGenerateStoryboard = async ({ ids }: { ids: number[] }) => {
    const uniqueIds = _.uniq(ids.filter((id) => Number.isInteger(id)));
    if (!uniqueIds.length) return "没有可生成的分镜";
    const thinking = msg.thinking("正在生成分镜...");
    if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "generate_storyboard_images");
    new Promise((resolve) => socket.emit("generateStoryboard", { ids: uniqueIds }, (res: any) => resolve(res)))
      .then((res) => {
        thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
        thinking.updateTitle("分镜生成完成");
        thinking.complete();
      })
      .catch((e) => {
        thinking.appendText("分镜生成失败:\n" + u.error(e).message);
        thinking.updateTitle("分镜生成失败");
        thinking.complete();
      });

    return "开始生成分镜";
  };
  const emitClientEvent = async (eventName: string, data: Record<string, any>) => {
    return await Promise.race([
      new Promise((resolve) => socket.emit(eventName, data, (res: any) => resolve(res))),
      new Promise((resolve) => setTimeout(() => resolve({ success: false, message: "前端刷新回调超时" }), 3000)),
    ]);
  };
  const getProjectVideoModelDetail = async (projectData: any) => {
    const [vendorId, modelName] = String(projectData?.videoModel || "").split(/:(.+)/);
    if (!vendorId || !modelName) return null;
    const models = await u.vendor.getModelList(vendorId);
    return models.find((item: any) => item.modelName === modelName) ?? null;
  };
  const storyboardPanelModeSchema = z.enum(["auto", "text", "imageReference", "singleImage"]);
  const resolveDurationValuesFromMap = (durationResolutionMap?: any): number[] => {
    if (!Array.isArray(durationResolutionMap)) return [];
    const values = durationResolutionMap
      .flatMap((item: any) => (Array.isArray(item?.duration) ? item.duration : []))
      .map((value: any) => Number(value))
      .filter((value: number) => Number.isFinite(value) && value > 0)
      .map((value: number) => Number(value.toFixed(3)));
    return [...new Set(values)].sort((a, b) => a - b);
  };
  const buildShotPolicyContext = (projectData: any, modelDetail?: any): ShotPolicyContext => {
    const allowedDurations = resolveDurationValuesFromMap(modelDetail?.durationResolutionMap);
    return {
      videoModel: projectData?.videoModel || null,
      videoModelName: modelDetail?.name || modelDetail?.modelName || null,
      allowedShotDurationSeconds: allowedDurations.length ? allowedDurations : null,
      secondsType: allowedDurations.length ? "discrete" : "range",
    };
  };
  const buildShotPolicyDescriptor = (projectData: any, modelDetail?: any) => {
    const context = buildShotPolicyContext(projectData, modelDetail);
    const allowedSeconds = resolveAllowedShotDurationSeconds(context);
    const minSeconds = resolveMinShotDurationSeconds(context);
    const maxSeconds = resolveMaxShotDurationSeconds(context);
    return {
      version: SHOT_POLICY_VERSION,
      videoModel: context.videoModel ?? null,
      videoModelName: context.videoModelName ?? null,
      minSeconds,
      maxSeconds,
      allowedSeconds,
      secondsType: allowedSeconds.length ? "discrete" : "range",
      targetDurationSource: "agent.shotTotalDuration",
      scriptTargetDurationPolicy: "referenceOnly",
      speechRatePolicy: {
        normal: "约2.5字/秒",
        fast: "接近3字/秒",
        emotional: "接近2字/秒",
      },
      rules: [
        "Agent 必须按剧本台词、语义停顿、动作节点和模型能力生成每个 shot 的秒数。",
        "代码只硬校验模型运行必需的单镜最短/最长/离散秒数，不按台词字数或语速阻断。",
        "同场景、同动作/情绪连续的多句台词可在模型单镜能力内合并，但必须在 durationReason 说明依据。",
      ],
    };
  };
  const getCurrentShotPolicyContext = async (): Promise<ShotPolicyContext> => {
    const projectId = Number(resTool.data.projectId);
    if (!projectId) return {};
    const projectData = await u.db("o_project").where("id", projectId).select("videoModel").first();
    const modelDetail = await getProjectVideoModelDetail(projectData);
    return buildShotPolicyContext(projectData, modelDetail);
  };
  const getVideoModelDefaultDuration = (modelDetail: any) => {
    const values = new Set<number>();
    if (Array.isArray(modelDetail?.durationResolutionMap)) {
      modelDetail.durationResolutionMap.forEach((item: any) => {
        (Array.isArray(item.duration) ? item.duration : []).forEach((duration: any) => {
          const value = Number(duration);
          if (Number.isFinite(value) && value > 0) values.add(value);
        });
      });
    }
    const sorted = Array.from(values).sort((a, b) => a - b);
    if (sorted.includes(10)) return 10;
    return sorted[0] || 10;
  };
  const parseDurationNumber = (value: string) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const chineseMap: Record<string, number> = {
      半: 0.5,
      一: 1,
      二: 2,
      两: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
    };
    return chineseMap[value] ?? NaN;
  };
  const parseScriptTargetDuration = (scriptContent: string) => {
    const lines = String(scriptContent || "")
      .split(/\r?\n/)
      .slice(0, 80)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .filter((line) => /目标时长|单集时长|视频时长|总时长/.test(line));

    for (const line of lines) {
      const minuteMatch = line.match(/([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(?:分钟|分|min(?:ute)?s?)\s*(?:(?:约|左右|内|以内)?\s*([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(?:秒|s))?/i);
      if (minuteMatch) {
        const minutes = parseDurationNumber(minuteMatch[1]);
        const seconds = minuteMatch[2] ? parseDurationNumber(minuteMatch[2]) : 0;
        const targetDuration = minutes * 60 + seconds;
        if (Number.isFinite(targetDuration) && targetDuration > 0) {
          return { targetDuration: Number(targetDuration.toFixed(3)), targetDurationSource: "script.targetDuration", raw: line };
        }
      }

      const secondMatch = line.match(/([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十半])\s*(?:秒|s(?:ec(?:ond)?s?)?\b)/i);
      if (secondMatch) {
        const targetDuration = parseDurationNumber(secondMatch[1]);
        if (Number.isFinite(targetDuration) && targetDuration > 0) {
          return { targetDuration: Number(targetDuration.toFixed(3)), targetDurationSource: "script.targetDuration", raw: line };
        }
      }
    }

    return null;
  };
  const resolveShotPlanTargetDuration = async (input: {
    explicitTargetDuration?: number | null;
    agentShotTotalDuration?: number | null;
    data: Record<string, any>;
    modelDetail?: any;
    scriptContent?: string | null;
  }) => {
    const scriptDuration = parseScriptTargetDuration(input.scriptContent || "");
    const agentTotal = Number(input.agentShotTotalDuration);
    if (Number.isFinite(agentTotal) && agentTotal > 0) {
      return {
        targetDuration: Number(agentTotal.toFixed(3)),
        targetDurationSource: "agent.shotTotalDuration",
        scriptTargetDuration: scriptDuration?.targetDuration ?? null,
        scriptTargetDurationSource: scriptDuration?.targetDurationSource ?? null,
        scriptTargetDurationRaw: scriptDuration?.raw ?? null,
      };
    }

    const explicit = Number(input.explicitTargetDuration);
    if (Number.isFinite(explicit) && explicit > 0) {
      return {
        targetDuration: Number(explicit.toFixed(3)),
        targetDurationSource: "tool.targetDuration",
        scriptTargetDuration: scriptDuration?.targetDuration ?? null,
        scriptTargetDurationSource: scriptDuration?.targetDurationSource ?? null,
        scriptTargetDurationRaw: scriptDuration?.raw ?? null,
      };
    }

    const workDataDuration = Number(input.data.targetDuration);
    if (Number.isFinite(workDataDuration) && workDataDuration > 0) {
      return {
        targetDuration: Number(workDataDuration.toFixed(3)),
        targetDurationSource: "workData.targetDuration",
        scriptTargetDuration: scriptDuration?.targetDuration ?? null,
        scriptTargetDurationSource: scriptDuration?.targetDurationSource ?? null,
        scriptTargetDurationRaw: scriptDuration?.raw ?? null,
      };
    }

    const storyboardRows = parseStoryboardTableRows(String(input.data.storyboardTable || ""));
    if (storyboardRows.length) {
      const total = storyboardRows.reduce((sum, row) => sum + Number(row.duration || 0), 0);
      if (Number.isFinite(total) && total > 0) {
        return {
          targetDuration: Number(total.toFixed(3)),
          targetDurationSource: "storyboardTable.totalDuration",
          scriptTargetDuration: scriptDuration?.targetDuration ?? null,
          scriptTargetDurationSource: scriptDuration?.targetDurationSource ?? null,
          scriptTargetDurationRaw: scriptDuration?.raw ?? null,
        };
      }
    }

    return {
      targetDuration: getVideoModelDefaultDuration(input.modelDetail),
      targetDurationSource: input.modelDetail ? "videoModel.defaultDuration" : "hardDefault.10s",
      scriptTargetDuration: scriptDuration?.targetDuration ?? null,
      scriptTargetDurationSource: scriptDuration?.targetDurationSource ?? null,
      scriptTargetDurationRaw: scriptDuration?.raw ?? null,
    };
  };
  const writeShotPlanToWorkspace = async ({
    plan,
    targetDuration,
    thinking,
    clearDraft = false,
  }: {
    plan: unknown;
    targetDuration?: number | null;
    thinking: ReturnType<typeof msg.thinking>;
    clearDraft?: boolean;
  }) => {
    const { projectId, scriptId } = resTool.data;
    if (!projectId || !scriptId) {
      return finishToolReturn(thinking, "镜头规划写入失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法写入镜头规划");
    }

    const parsedResult = ShotPlanInputSchema.safeParse(plan);
    if (!parsedResult.success) {
      return finishToolReturn(thinking, "镜头规划格式错误", parsedResult.error.message, `镜头规划格式错误：${parsedResult.error.message}`);
    }

    const { existing, data } = await getAgentWorkData();
    const [scriptData, projectData] = await Promise.all([
      u.db("o_script").where({ id: scriptId, projectId }).select("content").first(),
      u.db("o_project").where("id", projectId).first(),
    ]);
    if (!scriptData || !projectData) {
      return finishToolReturn(thinking, "镜头规划写入失败", "剧本或项目不存在", "剧本或项目不存在，无法写入镜头规划");
    }

    const relevantAssets = await getRelevantProjectAssets(u.db, projectId, scriptId);
    const modelDetail = await getProjectVideoModelDetail(projectData);
    const agentShotTotalDuration = parsedResult.data.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
    const resolvedDuration = await resolveShotPlanTargetDuration({
      explicitTargetDuration: targetDuration,
      agentShotTotalDuration,
      data,
      modelDetail,
      scriptContent: scriptData.content || "",
    });
    const currentFingerprint = buildShotPlanFingerprint({
      scriptContent: scriptData.content || "",
      project: projectData,
      relevantAssets,
    });

    const parsed = ShotPlanSchema.parse({
      ...parsedResult.data,
      ...currentFingerprint,
      targetDuration: resolvedDuration.targetDuration,
      targetDurationSource: resolvedDuration.targetDurationSource,
      totalEstimatedDuration: agentShotTotalDuration,
      updateTime: Date.now(),
    });

    const policyContext = buildShotPolicyContext(projectData, modelDetail);
    const violations = [...validateShotPlanStructure(parsed, policyContext), ...validateShotPlanAssets(parsed, relevantAssets)];
    if (violations.length) {
      return finishToolReturn(
        thinking,
        "镜头规划未通过校验",
        violations.map((item) => `- ${item}`).join("\n"),
        `镜头规划未通过校验，请修正后重新提交镜头规划：\n${violations.map((item) => `- ${item}`).join("\n")}`,
      );
    }

    data.shotPlan = parsed;
    data.targetDuration = parsed.targetDuration;
    data.targetDurationSource = parsed.targetDurationSource;
    data.scriptTargetDuration = resolvedDuration.scriptTargetDuration;
    data.scriptTargetDurationSource = resolvedDuration.scriptTargetDurationSource;
    data.scriptTargetDurationRaw = resolvedDuration.scriptTargetDurationRaw;
    if (clearDraft) delete data.shotPlanDraft;
    await saveAgentWorkData(existing, data);

    await emitClientEvent("setShotPlan", {
      projectId,
      scriptId,
      shotPlan: data.shotPlan,
      targetDuration: parsed.targetDuration,
      targetDurationSource: parsed.targetDurationSource,
      scriptTargetDuration: data.scriptTargetDuration,
      scriptTargetDurationSource: data.scriptTargetDurationSource,
      scriptTargetDurationRaw: data.scriptTargetDurationRaw,
      shotCount: parsed.shots.length,
      beatCount: parsed.beats.length,
    });

    return finishToolReturn(
      thinking,
      "镜头规划写入完成",
      `镜头规划写入完成：${parsed.beats.length} 个剧情节拍，${parsed.shots.length} 个镜头。`,
      `镜头规划写入完成：${parsed.beats.length} 个剧情节拍，${parsed.shots.length} 个镜头。`,
    );
  };
  const tools: Record<string, Tool> = {
    get_storyboard_first_state: tool({
      description: "读取当前剧集故事板先行工作流状态。故事板先行是独立分支，不读取分镜面板。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在读取故事板先行状态...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行状态读取失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        const data = await getStoryboardFirstState(projectId, scriptId);
        thinking.appendText(JSON.stringify(data, null, 2));
        thinking.updateTitle("故事板先行状态读取完成");
        thinking.complete();
        return data;
      },
    }),
    generate_storyboard_first_script: tool({
      description: "根据当前剧本生成故事板先行分镜脚本。不要调用分镜面板工具。",
      inputSchema: z.object({
        targetDuration: z.number().optional().describe("目标视频总时长，单位秒"),
        force: z.boolean().optional().default(false).describe("是否强制重新生成"),
      }),
      execute: async ({ targetDuration, force = false }) => {
        const thinking = msg.thinking("正在生成故事板先行分镜脚本...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行分镜脚本任务发起失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        const result = await startGenerateStoryboardFirstScript({ projectId, scriptId, targetDuration, force });
        const data = await getStoryboardFirstState(projectId, scriptId);
        thinking.appendText(`任务已发起，firstScriptId=${result.id}，reused=${result.reused}\n${JSON.stringify(data.script, null, 2)}`);
        thinking.updateTitle("故事板先行分镜脚本任务已发起");
        thinking.complete();
        return {
          state: data.script?.state || "生成中",
          firstScriptId: result.id,
          message: result.reused ? "已有故事板先行分镜脚本任务或结果" : "已开始生成故事板先行分镜脚本",
        };
      },
    }),
    update_storyboard_first_script: tool({
      description: "写入用户修订后的故事板先行分镜脚本，并使下游图片/视频动态过期。",
      inputSchema: z.object({
        firstScriptId: z.number(),
        shotScript: z.string().min(1),
      }),
      execute: async ({ firstScriptId, shotScript }) => {
        const thinking = msg.thinking("正在更新故事板先行分镜脚本...");
        await updateStoryboardFirstScript(firstScriptId, shotScript);
        thinking.updateTitle("故事板先行分镜脚本已更新");
        thinking.complete();
        return { state: "已完成", firstScriptId, message: "故事板先行分镜脚本已更新，下游图片/视频需重新生成" };
      },
    }),
    clear_storyboard_first_workflow: tool({
      description: "清空当前剧集故事板先行产物。只清理故事板先行三表和关联视频，不删除分镜面板。",
      inputSchema: z.object({
        confirm: z.literal(true),
      }),
      execute: async ({ confirm }) => {
        const thinking = msg.thinking("正在清空故事板先行工作流...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行工作流清空失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        await clearStoryboardFirstWorkflow(projectId, scriptId, confirm);
        thinking.updateTitle("故事板先行工作流已清空");
        thinking.complete();
        return { state: "未生成", message: "故事板先行工作流已清空" };
      },
    }),
    generate_storyboard_first_image: tool({
      description: "根据故事板先行分镜脚本生成或重生成竖版故事板图片。",
      inputSchema: z.object({
        firstScriptId: z.number(),
        force: z.boolean().optional().default(false),
      }),
      execute: async ({ firstScriptId, force = false }) => {
        const thinking = msg.thinking("正在生成故事板先行图片...");
        const result = await startGenerateStoryboardFirstImage(firstScriptId, force);
        thinking.updateTitle("故事板先行图片任务已发起");
        thinking.appendText(`firstImageId=${result.id}，reused=${result.reused}`);
        thinking.complete();
        return {
          state: "生成中",
          firstImageId: result.id,
          message: result.reused ? "已有故事板先行图片任务或结果" : "已开始生成故事板先行图片",
        };
      },
    }),
    generate_storyboard_first_video: tool({
      description: "根据故事板先行图片生成视频。这是故事板先行转视频专用工具，不写入主视频工作台。",
      inputSchema: z.object({
        firstImageId: z.number(),
        model: z.string(),
        duration: z.number(),
        resolution: z.string(),
        audio: z.boolean().optional().default(false),
      }),
      execute: async ({ firstImageId, model, duration, resolution, audio = false }) => {
        const thinking = msg.thinking("正在生成故事板先行视频...");
        const result = await startGenerateStoryboardFirstVideo({ firstImageId, model, duration, resolution, audio });
        thinking.updateTitle("故事板先行视频任务已发起");
        thinking.appendText(`firstVideoId=${result.id}，videoId=${result.videoId}，reused=${result.reused}`);
        thinking.complete();
        return {
          state: "生成中",
          firstVideoId: result.id,
          videoId: result.videoId,
          message: result.reused ? "已有故事板先行视频任务" : "已开始生成故事板先行视频",
        };
      },
    }),
    start_shot_plan: tool({
      description: "开始分块写入镜头规划。先写 beats 和可选总时长，不写 shots；随后用 append_shot_plan_shots 分批追加 shots。",
      inputSchema: z.object({
        beats: z.array(BeatSchema).min(1).describe("剧情节拍列表。只提交 beats，不要夹带 shots。"),
        targetDuration: z.number().positive().optional().describe("可选目标总时长；不传则最终按 shots 时长求和"),
        targetDurationSource: z.string().optional().default("agent.shotTotalDuration"),
        totalEstimatedDuration: z.number().positive().optional().describe("可选预估总时长；最终仍以 shots 时长求和"),
      }),
      execute: async ({ beats, targetDuration, targetDurationSource, totalEstimatedDuration }) => {
        const thinking = msg.thinking("正在开始分块镜头规划...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "镜头规划分块失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法开始镜头规划分块");
        }

        const { existing, data } = await getAgentWorkData();
        data.shotPlanDraft = {
          beats,
          shots: [],
          targetDuration: targetDuration ?? null,
          targetDurationSource: targetDurationSource || "agent.shotTotalDuration",
          totalEstimatedDuration: totalEstimatedDuration ?? null,
          updateTime: Date.now(),
        };
        data.shotPlan = null;
        data.storyboardTable = "";
        await saveAgentWorkData(existing, data);

        await emitClientEvent("setShotPlanDraft", {
          projectId,
          scriptId,
          beatCount: beats.length,
          shotCount: 0,
        });

        return finishToolReturn(
          thinking,
          "镜头规划分块已开始",
          `已写入 ${beats.length} 个剧情节拍。请继续用 append_shot_plan_shots 按 shotNo 顺序分批追加 shots，每批建议 8-12 个。`,
          `镜头规划分块已开始：${beats.length} 个剧情节拍。`,
        );
      },
    }),
    append_shot_plan_shots: tool({
      description:
        "向当前分块镜头规划追加一批 shots。每批建议 8-12 个；重复 shotNo 会覆盖旧值。最后一批设置 isFinal=true 后会执行完整校验并写入正式 shotPlan。",
      inputSchema: z.object({
        shots: z.array(ShotSchema).min(1).max(12).describe("本批镜头，按 shotNo 顺序提交。每批最多 12 个，避免工具参数过长。"),
        isFinal: z.boolean().optional().default(false).describe("是否为最后一批。true 时会合并全部批次并正式写入 shotPlan。"),
        targetDuration: z.number().positive().optional().describe("可选目标总时长；不传则最终按全部 shots 时长求和"),
      }),
      execute: async ({ shots, isFinal = false, targetDuration }) => {
        const thinking = msg.thinking(isFinal ? "正在完成分块镜头规划..." : "正在追加镜头规划分块...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "镜头规划分块失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法追加镜头规划");
        }

        const { existing, data } = await getAgentWorkData();
        const draft = data.shotPlanDraft;
        if (!draft || !Array.isArray(draft.beats)) {
          return finishToolReturn(
            thinking,
            "镜头规划分块失败",
            "当前没有进行中的镜头规划分块，请先调用 start_shot_plan。",
            "当前没有进行中的镜头规划分块，请先调用 start_shot_plan。",
          );
        }

        const shotMap = new Map<number, z.infer<typeof ShotSchema>>();
        for (const shot of Array.isArray(draft.shots) ? draft.shots : []) {
          const shotNo = Number(shot?.shotNo);
          if (Number.isInteger(shotNo) && shotNo > 0) shotMap.set(shotNo, shot);
        }
        for (const shot of shots) {
          shotMap.set(Number(shot.shotNo), shot);
        }
        const mergedShots = Array.from(shotMap.values()).sort((a, b) => Number(a.shotNo) - Number(b.shotNo));

        data.shotPlanDraft = {
          ...draft,
          shots: mergedShots,
          targetDuration: targetDuration ?? draft.targetDuration ?? null,
          updateTime: Date.now(),
        };
        await saveAgentWorkData(existing, data);

        await emitClientEvent("setShotPlanDraft", {
          projectId,
          scriptId,
          beatCount: draft.beats.length,
          shotCount: mergedShots.length,
          lastBatchCount: shots.length,
          isFinal,
        });

        if (!isFinal) {
          return finishToolReturn(
            thinking,
            "镜头规划分块已追加",
            `本批 ${shots.length} 个镜头，当前累计 ${mergedShots.length} 个镜头。继续追加下一批；最后一批请设置 isFinal=true。`,
            `镜头规划分块已追加：本批 ${shots.length} 个，累计 ${mergedShots.length} 个。`,
          );
        }

        return await writeShotPlanToWorkspace({
          plan: {
            targetDuration: targetDuration ?? draft.targetDuration ?? undefined,
            targetDurationSource: draft.targetDurationSource || "agent.shotTotalDuration",
            totalEstimatedDuration: draft.totalEstimatedDuration ?? undefined,
            beats: draft.beats,
            shots: mergedShots,
          },
          targetDuration: targetDuration ?? draft.targetDuration ?? undefined,
          thinking,
          clearDraft: true,
        });
      },
    }),
    set_shot_plan: tool({
      description: "兼容小项目的一次性镜头规划写入。镜头较多时优先使用 start_shot_plan + append_shot_plan_shots 分块写入。",
      inputSchema: z.object({
        plan: ShotPlanInputSchema,
        targetDuration: z.number().positive().optional(),
        targetDurationSource: z.string().optional(),
      }),
      execute: async ({ plan, targetDuration }) => {
        const thinking = msg.thinking("正在写入镜头规划...");
        return await writeShotPlanToWorkspace({ plan, targetDuration, thinking, clearDraft: true });
      },
    }),
    render_storyboard_table_from_shot_plan: tool({
      description: "根据当前工作区已通过校验的 shotPlan 自动渲染并写入分镜表。阶段4优先使用本工具。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在由镜头规划生成分镜表...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "分镜表生成失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法生成分镜表");
        }

        const { existing, data } = await getAgentWorkData();
        const parsedResult = ShotPlanSchema.safeParse(data.shotPlan);
        if (!parsedResult.success) {
          return finishToolReturn(
            thinking,
            "分镜表生成失败",
            "当前工作区没有有效 shotPlan",
            "当前工作区没有有效 shotPlan，请先通过 start_shot_plan + append_shot_plan_shots 写入镜头规划。",
          );
        }

        const currentFingerprint = await buildCurrentShotPlanFingerprint(u.db, projectId, scriptId);
        const staleReasons = findShotPlanStaleReasons(parsedResult.data, currentFingerprint);
        if (staleReasons.length) {
          return finishToolReturn(
            thinking,
            "shotPlan 已过期",
            staleReasons.map((item) => `- ${item}`).join("\n"),
            `shotPlan 已过期，必须重新写入镜头规划：\n${staleReasons.map((item) => `- ${item}`).join("\n")}`,
          );
        }

        const table = renderStoryboardTableFromShotPlan(parsedResult.data);
        const rows = parseStoryboardTableRows(table);
        const policyContext = await getCurrentShotPolicyContext();
        const tableViolations = validateStoryboardTableRows(rows, parsedResult.data.targetDuration, { requireCompleteTable: true }, policyContext);
        if (tableViolations.length) {
          return finishToolReturn(
            thinking,
            "分镜表生成失败",
            tableViolations.map((item) => `- ${item}`).join("\n"),
            `渲染后的分镜表未通过校验：\n${tableViolations.map((item) => `- ${item}`).join("\n")}`,
          );
        }

        data.storyboardTable = table;
        await saveAgentWorkData(existing, data);
        await emitClientEvent("setStoryboardTable", { projectId, scriptId, storyboardTable: table, rowCount: rows.length });

        return finishToolReturn(
          thinking,
          "分镜表生成完成",
          `已由 shotPlan 生成分镜表，共 ${rows.length} 行。`,
          `已由 shotPlan 生成分镜表，共 ${rows.length} 行。`,
        );
      },
    }),
    set_script_plan: tool({
      description: "写入阶段1导演计划。用于替代 XML 文本输出，必须传入完整导演计划正文。",
      inputSchema: z.object({
        content: z.string().min(120).describe("完整导演计划正文，包含分场汇总表、逐场注意事项、场间过渡等结构化内容"),
      }),
      execute: async ({ content }) => {
        const thinking = msg.thinking("正在写入导演计划...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "导演计划写入失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法写入导演计划");
        }

        const scriptPlan = String(content || "").trim();
        if (!/(分场汇总表|逐场注意事项|场间过渡|场次)/.test(scriptPlan)) {
          return finishToolReturn(
            thinking,
            "导演计划写入失败",
            "内容缺少导演计划必要结构",
            "写入失败：导演计划必须包含分场汇总表、逐场注意事项、场间过渡等结构化内容。",
          );
        }

        const { existing, data } = await getAgentWorkData();
        data.scriptPlan = scriptPlan;
        await saveAgentWorkData(existing, data);
        await emitClientEvent("setScriptPlan", {
          projectId,
          scriptId,
          scriptPlan,
          length: scriptPlan.length,
        });

        return finishToolReturn(
          thinking,
          "导演计划写入完成",
          `导演计划已写入，长度 ${scriptPlan.length} 字。`,
          `导演计划写入完成：${scriptPlan.length} 字。`,
        );
      },
    }),
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: z.object({
        key: keySchema.describe("数据key"),
      }),
      execute: async ({ key }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);
        console.log("[tools] get_flowData", key);
        const { source, value } = await getFlowDataValue(key);
        thinking.appendText(`来源：${source}\n${summarizeFlowDataValue(key, value)}`);
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
        thinking.complete();
        return value;
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.preprocess(
          (val) => {
            if (val === "null" || val === "" || val === undefined) return null;
            return val;
          },
          z.number().nullable().describe("衍生资产ID,如果新增则为空")),
        name: z.string().describe("衍生资产名称"),
        desc: z.string().describe("衍生资产描述"),
      }),
      execute: async (deriveAsset) => {
        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u
          .db("o_assets")
          .where("id", deriveAsset.assetsId)
          .select("id", "type", "volcengineAssetUri", "voiceProfile", "voiceTone", "speechRate")
          .first();
        if (!parentAssets) {
          return finishToolReturn(thinking, "资产操作失败", "关联的资产不存在", "关联的资产不存在");
        }

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          volcengineAssetUri: parentAssets.type === "role" ? (parentAssets.volcengineAssetUri ?? null) : null,
          voiceProfile: parentAssets.type === "role" ? (parentAssets.voiceProfile ?? null) : null,
          voiceTone: parentAssets.type === "role" ? (parentAssets.voiceTone ?? null) : null,
          speechRate: parentAssets.type === "role" ? (parentAssets.speechRate ?? null) : null,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.number().describe("衍生资产ID"),
      }),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: z.object({
        ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
      }),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("衍生资产生成失败:\n" + u.error(e).message);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
          });

        return "开始生成衍生资产";
      },
    }),
    clear_storyboard_panel: tool({
      description:
        "清空当前项目当前剧本的分镜面板。仅当最近用户消息明确要求清空/删除/重写/重新生成分镜面板，或重新执行/重跑阶段5时才允许调用；若最新消息是确认/自动推进，可沿用最近的明确授权。会同步删除旧分镜、分镜资产关联、视频轨道和关联视频，避免新分镜追加到旧分镜后面。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在清空分镜面板...");
        const { projectId, scriptId } = resTool.data;
        if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "clear_storyboard_panel");
        if (!projectId || !scriptId) {
          thinking.updateTitle("清空分镜面板失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文，无法清空分镜面板";
        }

        const recentUserMessages = await getRecentUserMessages();
        const latestUserMessage = recentUserMessages[0]?.content ?? "";
        if (!hasRecentStoryboardClearAuthorization(recentUserMessages)) {
          console.warn(
            `[productionAgent.clear_storyboard_panel] blocked projectId=${projectId} scriptId=${scriptId} latestUserMessage=${JSON.stringify(
              latestUserMessage.slice(0, 160),
            )}`,
          );
          thinking.updateTitle("清空分镜面板已拦截");
          thinking.appendText(
            `最近一条用户消息未明确要求清空/删除/重写分镜面板，已阻止破坏性操作。最近消息：${latestUserMessage.slice(0, 120) || "空"}`,
          );
          thinking.complete();
          return "已拦截：清空分镜面板属于破坏性操作，必须由用户在最近消息中明确要求清空、删除、重写、重新执行阶段5或重新生成分镜面板。";
        }

        const storyboardRows = await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "trackId");
        const storyboardIds = storyboardRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
        const trackIdsFromStoryboard = storyboardRows.map((item: any) => Number(item.trackId)).filter((id) => Number.isInteger(id));
        const trackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
        const trackIds = _.uniq([...trackIdsFromStoryboard, ...trackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id))]);

        console.log(
          `[productionAgent.clear_storyboard_panel] allowed projectId=${projectId} scriptId=${scriptId} storyboardCount=${storyboardIds.length} trackCount=${trackIds.length}`,
        );

        if (storyboardIds.length) {
          await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).del();
          await u.db("o_storyboard").whereIn("id", storyboardIds).del();
        }
        if (trackIds.length) {
          await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds).del();
          await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).del();
        }
        const { existing, data } = await getAgentWorkData();
        data.storyboard = [];
        data.workbench = { ...(data.workbench ?? {}), videoList: [] };
        await saveAgentWorkData(existing, data);

        await emitClientEvent("clearStoryboardPanel", {
          projectId,
          scriptId,
          storyboardCount: storyboardIds.length,
          trackCount: trackIds.length,
        });

        thinking.appendText(`已清空分镜 ${storyboardIds.length} 条，视频轨道 ${trackIds.length} 条。`);
        thinking.updateTitle("分镜面板已清空");
        thinking.complete();
        return `分镜面板已清空：删除分镜 ${storyboardIds.length} 条，视频轨道 ${trackIds.length} 条。`;
      },
    }),
    set_storyboard_table: tool({
      description:
        "异常兜底：写入当前项目当前剧本的标准 13 列分镜表。正常阶段4必须先写入 shotPlan，再调用 render_storyboard_table_from_shot_plan；只有自动渲染明确失败时才允许手动兜底。",
      inputSchema: z.object({
        content: z.string().min(1).describe("标准 13 列 Markdown 表格，必须包含：编号/画面描述/场景/资产/时长/景别/运镜/动作/情绪/光影/台词/音效/关联资产ID"),
        mode: z.enum(["replace", "append"]).default("replace").describe("replace 覆盖旧分镜表；append 追加到现有分镜表末尾"),
        isFinal: z.boolean().optional().default(false).describe("append 分块是否为最终块；replace 默认视为最终表"),
      }),
      execute: async ({ content, mode, isFinal }) => {
        const thinking = msg.thinking(mode === "append" ? "正在追加分镜表..." : "正在写入分镜表...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "写入分镜表失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法写入分镜表");
        }

        const normalizedContent = String(content || "").trim();
        const { existing, data } = await getAgentWorkData();
        const previousContent = String(data.storyboardTable || "").trim();
        const candidateTable = mode === "append" && previousContent ? `${previousContent}\n${normalizedContent}` : normalizedContent;
        const policyContext = await getCurrentShotPolicyContext();

        const chunkRows = parseStoryboardTableRows(normalizedContent);
        if (!chunkRows.length) {
          return finishToolReturn(thinking, "写入分镜表失败", "内容中未检测到分镜表行", "写入失败：内容中未检测到分镜表行");
        }

        const chunkViolations = validateStoryboardTableRows(chunkRows, null, { requireCompleteTable: false }, policyContext);
        if (chunkViolations.length) {
          return finishToolReturn(
            thinking,
            "写入分镜表失败",
            chunkViolations.map((item) => `- ${item}`).join("\n"),
            `写入失败：本次分块存在基础错误：\n${chunkViolations.map((item) => `- ${item}`).join("\n")}`,
          );
        }

        const candidateRows = parseStoryboardTableRows(candidateTable);
        const finalCheck = mode === "replace" || isFinal;
        if (finalCheck) {
          const parsedPlan = ShotPlanSchema.safeParse(data.shotPlan);
          const targetDuration = Number(parsedPlan.success ? parsedPlan.data.targetDuration : data.targetDuration || 0) || null;
          const candidateViolations = validateStoryboardTableRows(candidateRows, targetDuration, { requireCompleteTable: true }, policyContext);
          if (parsedPlan.success && candidateRows.length !== parsedPlan.data.shots.length) {
            candidateViolations.push(`分镜表行数 ${candidateRows.length} 与 shotPlan 镜头数 ${parsedPlan.data.shots.length} 不一致`);
          }
          if (candidateViolations.length) {
            return finishToolReturn(
              thinking,
              "写入分镜表失败",
              candidateViolations.map((item) => `- ${item}`).join("\n"),
              `写入失败：合并后的候选分镜表未通过规划校验：\n${candidateViolations.map((item) => `- ${item}`).join("\n")}`,
            );
          }
        }

        data.storyboardTable = candidateTable;
        await saveAgentWorkData(existing, data);
        await emitClientEvent("setStoryboardTable", {
          projectId,
          scriptId,
          storyboardTable: data.storyboardTable,
          rowCount: candidateRows.length,
        });

        return finishToolReturn(
          thinking,
          mode === "append" ? "分镜表追加完成" : "分镜表写入完成",
          `本次写入 ${chunkRows.length} 行，当前候选分镜表共 ${candidateRows.length} 行${finalCheck ? "，已完成完整校验" : "，等待最终块完整校验"}。`,
          `分镜表写入完成：本次 ${chunkRows.length} 行，当前共 ${candidateRows.length} 行。`,
        );
      },
    }),
    set_storyboard_panel_from_table: tool({
      description:
        "从当前工作区结构化镜头规划优先写入分镜面板，缺少 shotPlan 时才兜底解析分镜表。阶段5唯一写入入口；根据项目视频模型自动选择纯文本、图片参考或单图模式。必须按 startNo/endNo 分段调用，每批最多10条。",
      inputSchema: z.object({
        startNo: z.number().int().positive().optional().describe("起始分镜序号，1-based；必须分段传入，每批最多10条"),
        endNo: z.number().int().positive().optional().describe("结束分镜序号，1-based；必须分段传入，每批最多10条"),
        replaceAll: z.boolean().optional().default(false).describe("是否先清空当前分镜面板后重写全部行。破坏性操作，需最近用户明确授权；大批量重写应先 clear 后分段写入，不要用 replaceAll"),
        mode: storyboardPanelModeSchema.optional().default("auto").describe("写入模式。默认 auto：根据项目选择的视频模型 mode 自动选择 text/imageReference/singleImage"),
      }),
      execute: async ({ startNo, endNo, replaceAll = false, mode = "auto" }) => {
        const thinking = msg.thinking("正在结构化写入分镜面板...");
        const { projectId, scriptId } = resTool.data;
        if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "set_storyboard_panel_from_table");
        if (!projectId || !scriptId) {
          return finishToolReturn(thinking, "分镜面板写入失败", "缺少项目或剧本上下文", "缺少项目或剧本上下文，无法写入分镜面板");
        }

        if (replaceAll) {
          const recentUserMessages = await getRecentUserMessages();
          const latestUserMessage = recentUserMessages[0]?.content ?? "";
          if (!hasRecentStoryboardClearAuthorization(recentUserMessages)) {
            return finishToolReturn(
              thinking,
              "分镜面板重写已拦截",
              `最近一条用户消息未明确授权清空/重写分镜面板：${latestUserMessage.slice(0, 120) || "空"}`,
              "已拦截：replaceAll 会清空分镜面板，必须由用户在最近消息中明确要求清空、删除、重写、重新执行阶段5或重新生成分镜面板。",
            );
          }
        }

        const { existing, data } = await getAgentWorkData();
        const parsedPlan = ShotPlanSchema.safeParse(data.shotPlan);
        if (parsedPlan.success) {
          const currentFingerprint = await buildCurrentShotPlanFingerprint(u.db, projectId, scriptId);
          const staleReasons = findShotPlanStaleReasons(parsedPlan.data, currentFingerprint);
          if (staleReasons.length) {
            return finishToolReturn(
              thinking,
              "分镜面板写入失败",
              staleReasons.map((item) => `- ${item}`).join("\n"),
              `shotPlan 已过期，不能写入分镜面板：\n${staleReasons.map((item) => `- ${item}`).join("\n")}`,
            );
          }
        }

        let tableRows: ParsedStoryboardTableRow[] = [];
        let storyboardPanelSource = "storyboardTable";
        if (parsedPlan.success) {
          tableRows = materializeStoryboardRowsFromShotPlan(parsedPlan.data);
          storyboardPanelSource = "shotPlan";
          data.storyboardTable = renderStoryboardTableFromShotPlan(parsedPlan.data);
        } else {
          tableRows = parseStoryboardTableRows(String(data.storyboardTable || ""));
        }
        if (!tableRows.length) {
          return finishToolReturn(
            thinking,
            "分镜面板写入失败",
            "当前工作区未解析到有效分镜数据：没有可用 shotPlan，storyboardTable 也未解析到有效行",
            "写入失败：当前工作区未解析到有效分镜数据。",
          );
        }

        const targetDuration = Number(parsedPlan.success ? parsedPlan.data.targetDuration : data.targetDuration || 0) || null;
        const policyContext = await getCurrentShotPolicyContext();
        const tableViolations = validateStoryboardTableRows(tableRows, targetDuration, { requireCompleteTable: true }, policyContext);
        if (parsedPlan.success && tableRows.length !== parsedPlan.data.shots.length) {
          tableViolations.push(`分镜表行数 ${tableRows.length} 与 shotPlan 镜头数 ${parsedPlan.data.shots.length} 不一致`);
        }
        if (tableViolations.length) {
          return finishToolReturn(
            thinking,
            "分镜面板写入失败",
            tableViolations.map((item) => `- ${item}`).join("\n"),
            `写入失败：当前分镜表未通过规划校验：\n${tableViolations.map((item) => `- ${item}`).join("\n")}`,
          );
        }

        const allowLegacyAutoSplit = process.env.ALLOW_LEGACY_STORYBOARD_AUTO_SPLIT === "1";
        const materializedTableRows = allowLegacyAutoSplit
          ? expandStoryboardTableRows(tableRows)
          : tableRows.map((row, expandedIndex) => ({
              ...row,
              expandedIndex,
              originalDuration: row.duration,
              splitIndex: 0,
              splitCount: 1,
            }));
        const selectedRows = materializedTableRows.filter((row) => row.no >= (startNo ?? 1) && row.no <= (endNo ?? Number.MAX_SAFE_INTEGER));
        if (!selectedRows.length) {
          return finishToolReturn(thinking, "分镜面板写入失败", "指定范围内没有可写入的分镜表行", "写入失败：指定范围内没有可写入的分镜表行");
        }
        if (selectedRows.length > STORYBOARD_PANEL_WRITE_BATCH_SIZE) {
          const batchCalls = formatStoryboardPanelBatchRanges(selectedRows);
          return finishToolReturn(
            thinking,
            "分镜面板写入已拦截",
            [
              `本次请求写入 ${selectedRows.length} 条，超过单批上限 ${STORYBOARD_PANEL_WRITE_BATCH_SIZE} 条。`,
              "阶段5必须按 startNo/endNo 分段写入；即使分镜面板为空的首次写入，也不能一次性写入全部分镜。",
              replaceAll ? "本次未执行 replaceAll 清空；如需重写，请先单独调用 clear_storyboard_panel()，再分段写入。" : "",
              "建议按以下批次依次调用：",
              batchCalls,
            ]
              .filter(Boolean)
              .join("\n"),
            `写入被拦截：单批最多 ${STORYBOARD_PANEL_WRITE_BATCH_SIZE} 条。请按 startNo/endNo 分段调用 set_storyboard_panel_from_table。`,
          );
        }

        const existingStoryboards = await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "index", "trackId");
        if (replaceAll && existingStoryboards.length) {
          const storyboardIds = existingStoryboards.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
          const trackIds = existingStoryboards.map((item: any) => Number(item.trackId)).filter((id) => Number.isInteger(id));
          if (storyboardIds.length) {
            await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).del();
            await u.db("o_storyboard").whereIn("id", storyboardIds).del();
          }
          if (trackIds.length) {
            await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds).del();
            await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).del();
          }
        }

        const currentRows = replaceAll
          ? []
          : await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "index");
        const existingIndexes = new Set(currentRows.map((item: any) => Number(item.index)).filter((index) => Number.isInteger(index)));
        const projectSettingData = await u.db("o_project").where("id", projectId).select("artStyle", "videoModel", "mode").first();
        const modelDetail = await getProjectVideoModelDetail(projectSettingData);
        const panelMode = resolveStoryboardPanelMode(projectSettingData, modelDetail, mode);
        const shouldGenerateImage = panelMode.mode !== "text";
        const projectAssets: StoryboardAssetProjectAsset[] = await u.db("o_assets").where({ projectId }).select("id", "name", "type");
        const assetMap = new Map(projectAssets.map((asset) => [Number(asset.id), asset]));
        const insertedIds: number[] = [];

        for (const row of selectedRows) {
          const rowIndex = row.expandedIndex;
          if (existingIndexes.has(rowIndex)) continue;

          const prompt = shouldGenerateImage ? await buildStoryboardPrompt(row, assetMap, projectSettingData?.artStyle, projectId) : "";
          const videoDesc = buildStoryboardVideoDesc(row);
          const shotMeta = buildShotTimingMetaFromRow(row);
          const normalizedAssociateAssetsIds = normalizeStoryboardAssociateAssets(
            {
              associateAssetsIds: row.associateAssetsIds,
              prompt,
              videoDesc,
            },
            projectAssets,
          );
          const uniqueAssetIds = Array.from(
            new Set(normalizedAssociateAssetsIds.filter((assetId): assetId is number => Number.isInteger(assetId))),
          );
          const [insertedId] = await u.db("o_storyboard").insert({
            prompt,
            duration: String(row.duration || 1),
            state: "未生成",
            scriptId,
            projectId,
            index: rowIndex,
            track: "__AUTO__",
            videoDesc,
            shotMeta: JSON.stringify(shotMeta),
            shouldGenerateImage: shouldGenerateImage ? 1 : 0,
            createTime: Date.now(),
          });
          const storyboardId = Number(insertedId);
          insertedIds.push(storyboardId);
          if (uniqueAssetIds.length) {
            await u.db("o_assets2Storyboard").insert(
              uniqueAssetIds.map((assetId: number) => ({
                assetId,
                storyboardId,
              })),
            );
          }
        }

        await syncStoryboardTracks(projectId, scriptId);
        const persistedStoryboards = await getServerStoryboardPanelData();
        const persistedIndexes = new Set(
          persistedStoryboards.map((item) => Number(item.index)).filter((index) => Number.isInteger(index)),
        );
        const missingSelectedIndexes = selectedRows.map((row) => row.expandedIndex).filter((index) => !persistedIndexes.has(index));
        if (!persistedStoryboards.length || missingSelectedIndexes.length) {
          return finishToolReturn(
            thinking,
            "分镜面板写入失败",
            [
              `数据库复查未通过：当前真实分镜数 ${persistedStoryboards.length}`,
              missingSelectedIndexes.length ? `缺失分镜 index：${missingSelectedIndexes.join(", ")}` : "",
              `projectId=${projectId}, scriptId=${scriptId}`,
            ]
              .filter(Boolean)
              .join("\n"),
            `写入失败：分镜面板数据库复查未通过，真实分镜数 ${persistedStoryboards.length}。`,
          );
        }

        data.storyboard = [];
        await saveAgentWorkData(existing, data);
        const totalCount = persistedStoryboards.length;
        const clientRefreshResult = (await emitClientEvent("setStoryboardPanel", {
          projectId,
          scriptId,
          insertedCount: insertedIds.length,
          mode: panelMode.mode,
          totalCount,
        })) as any;
        if (!clientRefreshResult?.success || Number(clientRefreshResult?.storyboardCount ?? totalCount) <= 0) {
          return finishToolReturn(
            thinking,
            "分镜面板刷新失败",
            [
              `数据库真实分镜数：${totalCount}`,
              `前端回调：${clientRefreshResult?.message ?? "无回调"}`,
              "请刷新页面或重新打开当前剧集后再确认分镜面板。",
            ].join("\n"),
            `写入未完成：分镜面板数据库已有 ${totalCount} 条，但前端刷新未确认，不能继续下一阶段。原因：${clientRefreshResult?.message ?? "无回调"}`,
          );
        }
        thinking.appendText(
          `数据源：${storyboardPanelSource}。写入模式：${panelMode.label}（${panelMode.reason}）。本次写入 ${insertedIds.length} 条，当前分镜面板共 ${totalCount} 条。`,
        );
        thinking.updateTitle("分镜面板写入完成");
        thinking.complete();
        return `分镜面板写入完成：${panelMode.label}，本次 ${insertedIds.length} 条，当前共 ${totalCount} 条。`;
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: storyboardGenerateInputSchema,
      execute: executeGenerateStoryboard,
    }),
    generate_storyboard_images: tool({
      description: "生成分镜图片（兼容旧技能名）",
      inputSchema: storyboardGenerateInputSchema,
      execute: executeGenerateStoryboard,
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
