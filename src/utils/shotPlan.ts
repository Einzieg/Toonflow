import crypto from "crypto";
import { z } from "zod";
import {
  SHOT_POLICY_VERSION,
  findShotPolicyViolations,
  normalizePositiveDuration,
  type ShotPolicyContext,
} from "@/utils/shotPolicy";

export const NarrativeFunctionSchema = z.enum([
  "开场建立",
  "人物目标",
  "冲突推进",
  "信息揭示",
  "情绪反应",
  "动作高潮",
  "转折",
  "收束",
  "环境过场",
]);

export const BeatSchema = z.object({
  beatId: z.string().min(1),
  sourceText: z.string().min(1),
  narrativeFunction: NarrativeFunctionSchema,
  importance: z.number().int().min(1).max(5),
});

export const ShotSchema = z.object({
  shotNo: z.number().int().positive(),
  beatId: z.string().min(1),
  visualObjective: z.string().min(1),
  scene: z.string().default(""),
  characters: z.array(z.string()).default([]),
  actionUnit: z.string().min(1),
  dialogue: z.string().default("无台词"),
  shotSize: z.string().default("中景"),
  cameraMove: z.string().default("固定镜头"),
  emotion: z.string().default("平稳"),
  lighting: z.string().default("自然光"),
  sound: z.string().default("无音效"),
  assetNames: z.string().default(""),
  associateAssetsIds: z.array(z.number().int().positive()).default([]),
  noAssetReason: z.string().optional().default(""),
  duration: z.number().positive(),
  dialogueCharCount: z.coerce.number().nonnegative().nullable().optional(),
  estimatedSpeechRate: z.string().nullable().optional(),
  estimatedSpeechDuration: z.coerce.number().nonnegative().nullable().optional(),
  durationReason: z.string().nullable().optional(),
  durationReasonSource: z.enum(["agent", "manual", "unknown"]).nullable().optional().default("unknown"),
  splitReason: z.string().min(1),
  continuityNote: z.string().default(""),
});

export const ShotPlanSchema = z.object({
  targetDuration: z.number().positive(),
  targetDurationSource: z.string().default("set_shot_plan"),
  totalEstimatedDuration: z.number().positive().optional(),
  beats: z.array(BeatSchema).min(1),
  shots: z.array(ShotSchema).min(1),
  scriptHash: z.string().optional().default(""),
  assetHash: z.string().optional().default(""),
  projectContextHash: z.string().optional().default(""),
  shotPolicyVersion: z.string().optional().default(SHOT_POLICY_VERSION),
  updateTime: z.number().optional(),
});

export const ShotPlanInputSchema = ShotPlanSchema.extend({
  targetDuration: z.number().positive().optional(),
  targetDurationSource: z.string().optional().default("set_shot_plan"),
});

export type ShotPlan = z.infer<typeof ShotPlanSchema>;
export type ShotPlanInput = z.infer<typeof ShotPlanInputSchema>;

export interface ShotPlanContextFingerprint {
  scriptHash: string;
  assetHash: string;
  projectContextHash: string;
  shotPolicyVersion: string;
}

export interface RelevantProjectAsset {
  id: number;
  name?: string | null;
  type?: string | null;
  assetsId?: number | null;
  scriptId?: number | null;
  describe?: string | null;
  prompt?: string | null;
  remark?: string | null;
  volcengineAssetUri?: string | null;
}

export function stableHash(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function computeScriptHash(scriptContent: string): string {
  return stableHash({ scriptContent: String(scriptContent || "").replace(/\s+/g, " ").trim() });
}

export function computeProjectContextHash(project: {
  projectType?: string | null;
  type?: string | null;
  artStyle?: string | null;
  directorManual?: string | null;
  videoRatio?: string | null;
  imageModel?: string | null;
  videoModel?: string | null;
}): string {
  return stableHash({
    projectType: project.projectType || project.type || "",
    artStyle: project.artStyle || "",
    directorManual: project.directorManual || "",
    videoRatio: project.videoRatio || "",
    imageModel: project.imageModel || "",
    videoModel: project.videoModel || "",
  });
}

export async function getRelevantProjectAssets(db: any, projectId: number, scriptId: number): Promise<RelevantProjectAsset[]> {
  const scriptAssets = await db("o_scriptAssets").where("scriptId", scriptId).select("assetId");
  const rootAssetIds = Array.from(new Set(scriptAssets.map((item: any) => Number(item.assetId)).filter((id: number) => Number.isInteger(id))));
  if (!rootAssetIds.length) return [];

  const [rootAssets, childAssets] = await Promise.all([
    db("o_assets")
      .where("projectId", projectId)
      .whereIn("id", rootAssetIds)
      .select("id", "name", "type", "assetsId", "scriptId", "describe", "prompt", "remark", "volcengineAssetUri"),
    db("o_assets")
      .where("projectId", projectId)
      .whereIn("assetsId", rootAssetIds)
      .select("id", "name", "type", "assetsId", "scriptId", "describe", "prompt", "remark", "volcengineAssetUri"),
  ]);

  const byId = new Map<number, RelevantProjectAsset>();
  for (const asset of [...rootAssets, ...childAssets]) {
    byId.set(Number(asset.id), asset);
  }

  return Array.from(byId.values()).sort((a, b) => {
    const typeOrder = String(a.type || "").localeCompare(String(b.type || ""));
    return typeOrder || Number(a.id) - Number(b.id);
  });
}

export function computeAssetHash(assets: RelevantProjectAsset[]): string {
  return stableHash(
    assets.map((asset) => ({
      id: Number(asset.id),
      name: String(asset.name || ""),
      type: String(asset.type || ""),
      assetsId: asset.assetsId == null ? null : Number(asset.assetsId),
      scriptId: asset.scriptId == null ? null : Number(asset.scriptId),
      describe: String(asset.describe || asset.remark || asset.prompt || "").slice(0, 500),
      volcengineAssetUri: String(asset.volcengineAssetUri || ""),
    })),
  );
}

export function buildShotPlanFingerprint(input: {
  scriptContent: string;
  project: any;
  relevantAssets: RelevantProjectAsset[];
}): ShotPlanContextFingerprint {
  return {
    scriptHash: computeScriptHash(input.scriptContent || ""),
    assetHash: computeAssetHash(input.relevantAssets),
    projectContextHash: computeProjectContextHash(input.project || {}),
    shotPolicyVersion: SHOT_POLICY_VERSION,
  };
}

export async function buildCurrentShotPlanFingerprint(db: any, projectId: number, scriptId: number): Promise<ShotPlanContextFingerprint> {
  const [scriptData, projectData, relevantAssets] = await Promise.all([
    db("o_script").where({ id: scriptId, projectId }).select("content").first(),
    db("o_project").where("id", projectId).first(),
    getRelevantProjectAssets(db, projectId, scriptId),
  ]);
  return buildShotPlanFingerprint({
    scriptContent: scriptData?.content || "",
    project: projectData || {},
    relevantAssets,
  });
}

export function findShotPlanStaleReasons(plan: ShotPlan, current: ShotPlanContextFingerprint): string[] {
  const reasons: string[] = [];
  if (plan.scriptHash !== current.scriptHash) reasons.push("剧本内容已变化");
  if (plan.assetHash !== current.assetHash) reasons.push("当前剧集相关资产已变化");
  if (plan.projectContextHash !== current.projectContextHash) reasons.push("项目画风、导演手册、模型或画幅已变化");
  if (plan.shotPolicyVersion !== current.shotPolicyVersion) reasons.push("镜头策略版本已变化");
  return reasons;
}

function normalizeName(value: string) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function nameMatches(text: string, name?: string | null) {
  const a = normalizeName(text);
  const b = normalizeName(name || "");
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

export function validateShotPlanAssets(plan: ShotPlan, assets: RelevantProjectAsset[]): string[] {
  const violations: string[] = [];
  const assetMap = new Map(assets.map((asset) => [Number(asset.id), asset]));
  const roleAssets = assets.filter((asset) => asset.type === "role");
  const sceneAssets = assets.filter((asset) => asset.type === "scene");
  const toolAssets = assets.filter((asset) => asset.type === "tool");

  for (const shot of plan.shots) {
    const ids = Array.from(new Set(shot.associateAssetsIds || []));
    for (const id of ids) {
      if (!assetMap.has(Number(id))) {
        violations.push(`镜头 ${shot.shotNo} 引用了不存在或不属于当前剧集范围的资产 ID: ${id}`);
      }
    }

    const joined = [shot.visualObjective, shot.scene, shot.actionUnit, shot.assetNames, shot.characters.join("、")].join("\n");
    const matchedRoles = roleAssets.filter((asset) => shot.characters.some((name) => nameMatches(name, asset.name)) || nameMatches(joined, asset.name));
    const matchedScenes = sceneAssets.filter((asset) => nameMatches(shot.scene, asset.name));
    const matchedTools = toolAssets.filter((asset) => nameMatches(joined, asset.name));
    const requiredAssetIds = [...matchedRoles, ...matchedScenes, ...matchedTools].map((asset) => Number(asset.id));

    const missing = requiredAssetIds.filter((id) => !ids.includes(id));
    if (missing.length) {
      violations.push(`镜头 ${shot.shotNo} 提到了可匹配资产但未关联 ID: ${missing.join(", ")}`);
    }

    if (!ids.length && !requiredAssetIds.length && !String(shot.noAssetReason || "").trim()) {
      violations.push(`镜头 ${shot.shotNo} 未关联资产时必须填写 noAssetReason，例如“空镜/环境转场/无可用资产”`);
    }
  }

  return violations;
}

export function validateShotPlanStructure(plan: ShotPlan, context?: ShotPolicyContext | null): string[] {
  const violations: string[] = [];
  const beatIds = new Set(plan.beats.map((beat) => beat.beatId));
  const shotBeatIds = new Set(plan.shots.map((shot) => shot.beatId));

  for (const shot of plan.shots) {
    if (!beatIds.has(shot.beatId)) violations.push(`镜头 ${shot.shotNo} 引用了不存在的 beatId: ${shot.beatId}`);
  }

  for (const beat of plan.beats) {
    if (beat.importance >= 4 && !shotBeatIds.has(beat.beatId)) {
      violations.push(`关键剧情节拍 ${beat.beatId} 未被任何镜头覆盖`);
    }
  }

  const sortedNos = [...plan.shots].map((shot) => shot.shotNo).sort((a, b) => a - b);
  for (let index = 0; index < sortedNos.length; index++) {
    if (sortedNos[index] !== index + 1) {
      violations.push("shotNo 必须从 1 开始连续递增");
      break;
    }
  }

  violations.push(...findShotPolicyViolations(plan.shots, plan.targetDuration, context));
  return violations;
}

function escapeTableCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "／").trim();
}

export function renderStoryboardTableFromShotPlan(plan: ShotPlan): string {
  const header = [
    "| 编号 | 画面描述 | 场景 | 资产 | 时长 | 景别 | 运镜 | 动作 | 情绪 | 光影 | 台词 | 音效 | 关联资产ID |",
    "|---|---|---|---|---:|---|---|---|---|---|---|---|---|",
  ];

  const rows = plan.shots.map((shot) => {
    const cells = [
      shot.shotNo,
      shot.visualObjective,
      shot.scene,
      shot.assetNames || shot.characters.join("、") || shot.noAssetReason || "无资产",
      `${normalizePositiveDuration(shot.duration)}s`,
      shot.shotSize,
      shot.cameraMove,
      shot.actionUnit,
      shot.emotion,
      shot.lighting,
      shot.dialogue || "无台词",
      shot.sound || "无音效",
      `[${shot.associateAssetsIds.join(",")}]`,
    ].map(escapeTableCell);
    return `| ${cells.join(" | ")} |`;
  });

  return [...header, ...rows].join("\n");
}
