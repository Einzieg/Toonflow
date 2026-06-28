import { getGrokVideoSupportedDurations, isGrokImagineVideo15PreviewModel, isGrokImagineVideoModel } from "@/utils/storyboardTrack";

export const SHOT_POLICY_VERSION = "shot-policy:v7";
export const MIN_SHOT_DURATION_SECONDS = 1.5;
export const DEFAULT_MAX_SHOT_DURATION_SECONDS = 5;
export const GROK_VIDEO_MIN_SHOT_DURATION_SECONDS = 4;
export const GROK_VIDEO_MAX_SHOT_DURATION_SECONDS = 10;
export const GROK_VIDEO_15_PREVIEW_MIN_SHOT_DURATION_SECONDS = 3;
export const GROK_VIDEO_15_PREVIEW_MAX_SHOT_DURATION_SECONDS = 15;
export const MAX_SHOT_DURATION_SECONDS = DEFAULT_MAX_SHOT_DURATION_SECONDS;
export const DEFAULT_TARGET_DURATION_SECONDS = 10;

export interface ShotPolicyContext {
  videoModel?: string | null;
  videoModelName?: string | null;
  minShotDurationSeconds?: number | null;
  maxShotDurationSeconds?: number | null;
  allowedShotDurationSeconds?: number[] | null;
  secondsType?: "range" | "discrete" | string | null;
}

export function normalizePositiveDuration(value: unknown, fallback = 1): number {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return fallback;
  return Number(duration.toFixed(3));
}

export function resolveMaxShotDurationSeconds(context?: ShotPolicyContext | null): number {
  const allowedDurations = resolveAllowedShotDurationSeconds(context);
  if (allowedDurations.length) return allowedDurations[allowedDurations.length - 1];

  const explicitMax = Number(context?.maxShotDurationSeconds);
  if (Number.isFinite(explicitMax) && explicitMax > 0) return Number(explicitMax.toFixed(3));

  const videoModel = context?.videoModel || "";
  const videoModelName = context?.videoModelName || "";
  if (isGrokImagineVideo15PreviewModel(videoModel, videoModelName)) return GROK_VIDEO_15_PREVIEW_MAX_SHOT_DURATION_SECONDS;
  if (isGrokImagineVideoModel(videoModel, videoModelName)) return GROK_VIDEO_MAX_SHOT_DURATION_SECONDS;
  return DEFAULT_MAX_SHOT_DURATION_SECONDS;
}

export function resolveMinShotDurationSeconds(context?: ShotPolicyContext | null): number {
  const allowedDurations = resolveAllowedShotDurationSeconds(context);
  if (allowedDurations.length) return allowedDurations[0];

  const explicitMin = Number(context?.minShotDurationSeconds);
  if (Number.isFinite(explicitMin) && explicitMin > 0) return Number(explicitMin.toFixed(3));

  const videoModel = context?.videoModel || "";
  const videoModelName = context?.videoModelName || "";
  if (isGrokImagineVideo15PreviewModel(videoModel, videoModelName)) return GROK_VIDEO_15_PREVIEW_MIN_SHOT_DURATION_SECONDS;
  if (isGrokImagineVideoModel(videoModel, videoModelName)) return GROK_VIDEO_MIN_SHOT_DURATION_SECONDS;
  return MIN_SHOT_DURATION_SECONDS;
}

export function resolveAllowedShotDurationSeconds(context?: ShotPolicyContext | null): number[] {
  const explicit = Array.isArray(context?.allowedShotDurationSeconds)
    ? context.allowedShotDurationSeconds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Number(value.toFixed(3)))
    : [];
  if (explicit.length) return [...new Set(explicit)].sort((a, b) => a - b);

  const videoModel = context?.videoModel || "";
  const videoModelName = context?.videoModelName || "";
  if (isGrokImagineVideoModel(videoModel, videoModelName)) {
    return getGrokVideoSupportedDurations(videoModel, videoModelName);
  }

  return [];
}

function isAllowedDuration(duration: number, allowedDurations: number[]) {
  return allowedDurations.some((allowed) => Math.abs(duration - allowed) < 0.001);
}

export function resolveShotCountUnitSeconds(context?: ShotPolicyContext | null): number {
  return resolveMaxShotDurationSeconds(context);
}

export function recommendedShotCount(targetDuration: number, context?: ShotPolicyContext | null): number {
  const duration = normalizePositiveDuration(targetDuration, DEFAULT_TARGET_DURATION_SECONDS);
  if (duration <= 6) return 3;
  if (duration <= 10) return 4;
  if (duration <= 15) return 5;
  if (isGrokImagineVideoModel(context?.videoModel || "", context?.videoModelName || "")) {
    return Math.max(minShotCount(duration, context), Math.ceil(duration / resolveMaxShotDurationSeconds(context)));
  }
  return Math.max(1, Math.ceil(duration / 4));
}

export function minShotCount(targetDuration: number, context?: ShotPolicyContext | null): number {
  const countUnitDuration = resolveShotCountUnitSeconds(context);
  return Math.max(1, Math.ceil(normalizePositiveDuration(targetDuration, DEFAULT_TARGET_DURATION_SECONDS) / countUnitDuration));
}

export function buildShotPolicyLines(targetDuration: number, context?: ShotPolicyContext | null): string[] {
  const duration = normalizePositiveDuration(targetDuration, DEFAULT_TARGET_DURATION_SECONDS);
  const minShotDuration = resolveMinShotDurationSeconds(context);
  const maxShotDuration = resolveMaxShotDurationSeconds(context);
  const countUnitDuration = resolveShotCountUnitSeconds(context);
  const minimum = minShotCount(duration, context);
  const recommended = recommendedShotCount(duration, context);
  const lines = [
    `单个镜头时长必须在 ${minShotDuration}-${maxShotDuration} 秒之间。`,
    `本次 Agent 规划总时长约 ${duration}s；按模型能力建议至少 ${minimum} 个镜头，参考 ${recommended} 个镜头。`,
    `超过 ${maxShotDuration} 秒的连续动作、情绪变化、发现线索、冲突爆发或台词段落必须拆成多个镜头。`,
  ];
  if (maxShotDuration > DEFAULT_MAX_SHOT_DURATION_SECONDS) {
    lines.push(`当前视频模型允许单镜校验上限放宽到 ${maxShotDuration}s，但仍需在动作、情绪、台词或场景转折处主动拆镜，不能为了贴近上限强行合并。`);
  }
  if (countUnitDuration < maxShotDuration) {
    lines.push(`最低镜头数按 ${countUnitDuration}s 推荐节奏计算；${maxShotDuration}s 只作为单镜校验上限。`);
  }
  if (Math.abs(duration - 10) < 0.01) lines.push("10 秒视频建议 3-5 个镜头，推荐 4 个镜头。");
  if (Math.abs(duration - 15) < 0.01) lines.push("15 秒视频建议 4-6 个镜头。");
  return lines;
}

export function findShotPolicyViolations<T extends { shotNo?: number; duration?: unknown }>(
  shots: T[],
  _targetDuration?: unknown,
  context?: ShotPolicyContext | null,
): string[] {
  const violations: string[] = [];
  const minShotDuration = resolveMinShotDurationSeconds(context);
  const maxShotDuration = resolveMaxShotDurationSeconds(context);
  const allowedDurations = resolveAllowedShotDurationSeconds(context);
  for (const shot of shots) {
    const shotNo = Number(shot.shotNo || 0) || "?";
    const duration = Number(shot.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      violations.push(`镜头 ${shotNo} 时长无效`);
    } else if (duration < minShotDuration) {
      violations.push(`镜头 ${shotNo} 时长 ${duration}s 过短，低于 ${minShotDuration}s`);
    } else if (duration > maxShotDuration) {
      violations.push(`镜头 ${shotNo} 时长 ${duration}s 过长，必须拆分到 ${maxShotDuration}s 以内`);
    } else if (allowedDurations.length && !isAllowedDuration(duration, allowedDurations)) {
      violations.push(`镜头 ${shotNo} 时长 ${duration}s 不受当前视频模型支持，必须使用以下秒数之一：${allowedDurations.join(", ")}`);
    }
  }

  return violations;
}
