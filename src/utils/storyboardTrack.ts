export const MAX_TRACK_DURATION_SECONDS = 15;
export const STORYBOARD_AUTO_TRACK_KEY = "__AUTO__";
export const GROK_VIDEO_MIN_DURATION_SECONDS = 4;
export const GROK_VIDEO_MAX_DURATION_SECONDS = 10;
export const GROK_VIDEO_SUPPORTED_DURATIONS = [4, 5, 6, 7, 8, 9, 10] as const;
export const GROK_VIDEO_15_PREVIEW_MIN_DURATION_SECONDS = 3;
export const GROK_VIDEO_15_PREVIEW_MAX_DURATION_SECONDS = 15;
export const GROK_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

type Nullable<T> = T | null | undefined;

export interface VideoDurationRange {
  min: number;
  max: number;
}

export interface StoryboardTrackItem {
  id?: number;
  index?: Nullable<number>;
  track?: Nullable<string>;
  trackId?: Nullable<number>;
  duration?: Nullable<number | string>;
  dialogue?: Nullable<string>;
  videoDesc?: Nullable<string>;
}

export type PlannedStoryboardTrackItem<T extends StoryboardTrackItem> = Omit<T, "duration"> & {
  duration: number;
};

export interface PlannedStoryboardSegment<T extends StoryboardTrackItem> {
  trackLabel: string;
  baseTrack: string;
  duration: number;
  items: Array<PlannedStoryboardTrackItem<T>>;
}

function sanitizeDurationValue(rawDuration: Nullable<number | string>, fallback = 1): number {
  const duration = Number(rawDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return fallback;
  }
  return Number(duration.toFixed(3));
}

export function normalizeStoryboardDuration(rawDuration: Nullable<number | string>): number {
  return sanitizeDurationValue(rawDuration);
}

export function normalizeStoryboardTrack(track: Nullable<string>): string {
  const normalized = String(track ?? "").trim();
  // Numeric labels are generated track numbers, not hard grouping keys.
  // Treat them as auto so re-sync can keep one storyboard per video track.
  if (!normalized || /^\d+$/.test(normalized)) return STORYBOARD_AUTO_TRACK_KEY;
  return normalized;
}

export function createManualStoryboardTrackKey(trackId: number): string {
  return `manual:${trackId}`;
}

export function getPlannedStoryboardTrackStorageValue<T extends StoryboardTrackItem>(segment: PlannedStoryboardSegment<T>): string {
  return segment.baseTrack === STORYBOARD_AUTO_TRACK_KEY ? segment.trackLabel : segment.baseTrack;
}

export function extractStoryboardDialogue(item: Pick<StoryboardTrackItem, "dialogue" | "videoDesc">): string {
  const directDialogue = String(item.dialogue ?? "").replace(/\s+/g, " ").trim();
  if (directDialogue && !/^无(?:台词|对白|配音)?[。.!！]?$/i.test(directDialogue)) return directDialogue;

  const videoDesc = String(item.videoDesc ?? "").replace(/\s+/g, " ").trim();
  const match = videoDesc.match(/(?:【台词】|台词[：:])\s*(.*?)(?:【音效】|音效[：:]|【关联资产ID】|关联资产(?:ID)?[：:]|$)/);
  const dialogue = String(match?.[1] || "").trim().replace(/[。；;]\s*$/, "");
  if (!dialogue || /^无(?:台词|对白|配音)?[。.!！]?$/i.test(dialogue)) return "";
  return dialogue;
}

export function hasStoryboardDialogue(item: Pick<StoryboardTrackItem, "dialogue" | "videoDesc">): boolean {
  return Boolean(extractStoryboardDialogue(item));
}

function normalizeText(value: Nullable<string>): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extractMarkedVideoDescField(videoDesc: Nullable<string>, field: string, nextFields: string[]) {
  const text = normalizeText(videoDesc);
  const nextPattern = nextFields.map((item) => `(?:【${item}】|${item}[：:])`).join("|");
  const pattern = new RegExp(`(?:【${field}】|${field}[：:])\\s*(.*?)(?=${nextPattern ? nextPattern + "|" : ""}$)`);
  return normalizeText(text.match(pattern)?.[1] || "");
}

function extractStoryboardScene(item: Pick<StoryboardTrackItem, "videoDesc">): string {
  const scene = extractMarkedVideoDescField(item.videoDesc, "场景", ["镜头", "动作", "情绪", "光影", "台词", "音效", "关联资产ID"]);
  if (!scene || /^(同上|同场景|原场景|当前场景|同一场景)$/i.test(scene)) return "";
  return scene
    .replace(/[，。,；;：:\s]+/g, "")
    .replace(/(?:内|外|中|里|前|后|附近|一角)$/g, "")
    .trim();
}

function containsStoryboardHardCutCue(item: Pick<StoryboardTrackItem, "videoDesc">): boolean {
  const text = normalizeText(item.videoDesc);
  if (!text) return false;
  const sceneText = extractMarkedVideoDescField(item.videoDesc, "场景", ["镜头", "动作", "情绪", "光影", "台词", "音效", "关联资产ID"]);
  const shotText = extractMarkedVideoDescField(item.videoDesc, "镜头", ["动作", "情绪", "光影", "台词", "音效", "关联资产ID"]);
  const actionText = extractMarkedVideoDescField(item.videoDesc, "动作", ["情绪", "光影", "台词", "音效", "关联资产ID"]);
  const searchable = [sceneText, shotText, actionText, text].join(" ");
  return /(?:转场|专场|硬切|切到|切至|切回|切入|切出|切换(?:到|至)?|镜头(?:切到|切至|转向|转至)|画面(?:切到|切至|转到|转至)|视角(?:切换|转为|转到|转至|变化)|切视角|反打|正反打|主观视角|客观视角|第一人称视角|第三人称视角|过肩视角|过肩镜头|闪回|闪白|闪黑|淡入|淡出|叠化|跳切|另一边|与此同时|同一时间)/i.test(
    searchable,
  );
}

export function hasStoryboardTrackHardBoundary<T extends StoryboardTrackItem>(left: T | null | undefined, right: T | null | undefined): boolean {
  if (!left || !right) return false;
  const leftScene = extractStoryboardScene(left);
  const rightScene = extractStoryboardScene(right);
  if (leftScene && rightScene && leftScene !== rightScene) return true;
  return containsStoryboardHardCutCue(left) || containsStoryboardHardCutCue(right);
}

export function isSeedance2VideoModel(model?: Nullable<string>, displayName?: Nullable<string>): boolean {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("seedance") && (value.includes("seedance-2-0") || value.includes("seedance-2.0") || value.includes("seedance2.0"));
}

export function isGrokImagineVideoModel(model?: Nullable<string>, displayName?: Nullable<string>): boolean {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video") || (value.includes("grok") && value.includes("imagine") && value.includes("video"));
}

export function isGrokImagineVideo15PreviewModel(model?: Nullable<string>, displayName?: Nullable<string>): boolean {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video-1.5-preview") || value.includes("grokimaginevideo1.5preview");
}

export function getVideoModelVendorId(model?: Nullable<string>): string {
  return String(model ?? "").split(/:(.+)/)[0] || "";
}

export function shouldUsePublicImageReferenceForVideoModel(model?: Nullable<string>): boolean {
  return ["cliproxyapi", "888api", "dszyym"].includes(getVideoModelVendorId(model));
}

export function shouldForceSingleImageReferenceForVideoModel(model?: Nullable<string>, displayName?: Nullable<string>): boolean {
  const vendorId = getVideoModelVendorId(model);
  return ["cliproxyapi", "dszyym"].includes(vendorId) && isGrokImagineVideo15PreviewModel(model, displayName);
}

export function getGrokVideoSupportedDurations(model?: Nullable<string>, displayName?: Nullable<string>): number[] {
  if (isGrokImagineVideo15PreviewModel(model, displayName)) {
    return [...GROK_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS];
  }
  return [...GROK_VIDEO_SUPPORTED_DURATIONS];
}

function resolveDurationValuesFromMap(durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>): number[] {
  if (!Array.isArray(durationResolutionMap)) return [];
  const values = durationResolutionMap
    .flatMap((item) => (Array.isArray(item?.duration) ? item.duration : []))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

function resolveDurationRangeFromMap(durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>): VideoDurationRange | null {
  const values = resolveDurationValuesFromMap(durationResolutionMap);
  if (!values.length) return null;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function resolveVideoModelDurationRange(
  model?: Nullable<string>,
  displayName?: Nullable<string>,
  durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>,
): VideoDurationRange {
  const mappedRange = resolveDurationRangeFromMap(durationResolutionMap);
  if (isGrokImagineVideoModel(model, displayName)) {
    if (mappedRange) return mappedRange;
    if (isGrokImagineVideo15PreviewModel(model, displayName)) {
      return {
        min: GROK_VIDEO_15_PREVIEW_MIN_DURATION_SECONDS,
        max: GROK_VIDEO_15_PREVIEW_MAX_DURATION_SECONDS,
      };
    }
    return {
      min: GROK_VIDEO_MIN_DURATION_SECONDS,
      max: GROK_VIDEO_MAX_DURATION_SECONDS,
    };
  }
  return mappedRange ?? { min: 1, max: MAX_TRACK_DURATION_SECONDS };
}

export function formatVideoDurationRange(range: VideoDurationRange): string {
  const min = Number(range.min.toFixed(3));
  const max = Number(range.max.toFixed(3));
  return min === max ? `${min}s` : `${min}-${max}s`;
}

export function clampVideoDurationToRange(duration: Nullable<number | string>, range: VideoDurationRange): number {
  const value = sanitizeDurationValue(duration, range.min);
  return Number(Math.min(Math.max(value, range.min), range.max).toFixed(3));
}

function snapDurationToSupportedValues(duration: Nullable<number | string>, supportedValues: number[]): number {
  const values = supportedValues.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!values.length) return sanitizeDurationValue(duration);
  const clamped = clampVideoDurationToRange(duration, { min: values[0], max: values[values.length - 1] });
  return values.reduce((best, current) => (Math.abs(current - clamped) <= Math.abs(best - clamped) ? current : best), values[0]);
}

export function resolveGrokVideoDuration(
  duration: Nullable<number | string>,
  model?: Nullable<string>,
  displayName?: Nullable<string>,
  durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>,
): number {
  const mappedValues = resolveDurationValuesFromMap(durationResolutionMap);
  return snapDurationToSupportedValues(duration, mappedValues.length ? mappedValues : getGrokVideoSupportedDurations(model, displayName));
}

export function resolveVideoGenerationDuration(
  model: Nullable<string>,
  duration: Nullable<number | string>,
  displayName?: Nullable<string>,
  durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>,
): number {
  if (isGrokImagineVideoModel(model, displayName)) {
    return resolveGrokVideoDuration(duration, model, displayName, durationResolutionMap);
  }
  return clampVideoDurationToRange(duration, resolveVideoModelDurationRange(model, displayName, durationResolutionMap));
}

export function resolveStoryboardTrackTargetDuration(
  model?: Nullable<string>,
  displayName?: Nullable<string>,
  durationResolutionMap?: Nullable<Array<{ duration?: unknown[] }>>,
): number {
  return resolveVideoModelDurationRange(model, displayName, durationResolutionMap).max;
}

export function normalizeVideoModelDurationMap<T extends { name?: string; modelName?: string; durationResolutionMap?: { duration: number[]; resolution: string[] }[] }>(model: T): T {
  if (!Array.isArray(model.durationResolutionMap)) return model;
  if (isGrokImagineVideoModel(model.modelName, model.name)) {
    const modelSupportedDurations = resolveDurationValuesFromMap(model.durationResolutionMap);
    const supportedDurations = modelSupportedDurations.length ? modelSupportedDurations : getGrokVideoSupportedDurations(model.modelName, model.name);
    return {
      ...model,
      durationResolutionMap: model.durationResolutionMap.map((item) => ({
        ...item,
        duration: supportedDurations,
      })),
    };
  }
  return model;
}

export function expandStoryboardItemsForDuration<T extends StoryboardTrackItem>(items: T[], maxDuration = MAX_TRACK_DURATION_SECONDS): Array<PlannedStoryboardTrackItem<T>> {
  const result: Array<PlannedStoryboardTrackItem<T>> = [];
  items.forEach((item) => {
    let remaining = normalizeStoryboardDuration(item.duration);
    while (remaining > 0) {
      const chunkDuration = Number(Math.min(remaining, maxDuration).toFixed(3));
      result.push({
        ...item,
        duration: chunkDuration,
      });
      remaining = Number((remaining - chunkDuration).toFixed(3));
    }
  });
  return result;
}

export function planStoryboardTrackSegments<T extends StoryboardTrackItem>(items: T[], maxDuration = MAX_TRACK_DURATION_SECONDS): Array<PlannedStoryboardSegment<T>> {
  const segments: Array<PlannedStoryboardSegment<T>> = [];
  let currentSegment: PlannedStoryboardSegment<T> | null = null;

  items.forEach((item) => {
    const duration = normalizeStoryboardDuration(item.duration);
    const segmentDuration = Math.min(duration, maxDuration);
    const baseTrack = normalizeStoryboardTrack(item.track);
    const plannedItem: PlannedStoryboardTrackItem<T> = {
      ...item,
      duration,
    };

    const isAutoTrack = baseTrack === STORYBOARD_AUTO_TRACK_KEY;
    if (
      !currentSegment ||
      isAutoTrack ||
      currentSegment.baseTrack !== baseTrack ||
      currentSegment.duration + duration > maxDuration
    ) {
      currentSegment = {
        trackLabel: String(segments.length + 1),
        baseTrack,
        duration: 0,
        items: [],
      };
      segments.push(currentSegment);
    }

    currentSegment.items.push(plannedItem);
    currentSegment.duration = Number((currentSegment.duration + segmentDuration).toFixed(3));
  });

  return segments.map((segment, index) => ({
    ...segment,
    trackLabel: String(index + 1),
  }));
}

function segmentHasDialogue<T extends StoryboardTrackItem>(segment: PlannedStoryboardSegment<T>): boolean {
  return segment.items.some(hasStoryboardDialogue);
}

function segmentDuration<T extends StoryboardTrackItem>(items: Array<PlannedStoryboardTrackItem<T>>): number {
  return Number(items.reduce((sum, item) => sum + normalizeStoryboardDuration(item.duration), 0).toFixed(3));
}

function canMergeSegments<T extends StoryboardTrackItem>(
  left: PlannedStoryboardSegment<T>,
  right: PlannedStoryboardSegment<T>,
  maxDuration: number,
) {
  const leftEdge = left.items[left.items.length - 1];
  const rightEdge = right.items[0];
  return (
    left.baseTrack === right.baseTrack &&
    Number((left.duration + right.duration).toFixed(3)) <= maxDuration &&
    !hasStoryboardTrackHardBoundary(leftEdge, rightEdge)
  );
}

function refreshSegmentDuration<T extends StoryboardTrackItem>(segment: PlannedStoryboardSegment<T>) {
  segment.duration = segmentDuration(segment.items);
}

function refreshSegmentDurationCapped<T extends StoryboardTrackItem>(segment: PlannedStoryboardSegment<T>, maxDuration: number) {
  segment.duration = Math.min(segmentDuration(segment.items), maxDuration);
}

function rebalanceSilentSegments<T extends StoryboardTrackItem>(
  inputSegments: Array<PlannedStoryboardSegment<T>>,
  maxDuration: number,
): Array<PlannedStoryboardSegment<T>> {
  const segments = inputSegments.map((segment) => ({
    ...segment,
    items: [...segment.items],
  }));

  // First pass: merge fully silent segments into adjacent dialogue segments when it fits.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segmentHasDialogue(segment)) continue;

    const next = segments[index + 1];
    if (next && segmentHasDialogue(next) && canMergeSegments(segment, next, maxDuration)) {
      next.items = [...segment.items, ...next.items];
      refreshSegmentDuration(next);
      segments.splice(index, 1);
      index -= 1;
      continue;
    }

    const previous = segments[index - 1];
    if (previous && segmentHasDialogue(previous) && canMergeSegments(previous, segment, maxDuration)) {
      previous.items = [...previous.items, ...segment.items];
      refreshSegmentDuration(previous);
      segments.splice(index, 1);
      index -= 1;
    }
  }

  // Second pass: if a silent segment cannot be fully merged, move as many edge
  // shots as possible into the adjacent dialogue segment. This keeps visual
  // setup/tail beats attached to spoken conflict instead of becoming standalone
  // silent videos.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segmentHasDialogue(segment)) continue;

    const next = segments[index + 1];
    while (next && segment.items.length > 1 && segment.baseTrack === next.baseTrack && segmentHasDialogue(next)) {
      const moved = segment.items[segment.items.length - 1];
      const movedDuration = normalizeStoryboardDuration(moved.duration);
      if (next.duration + movedDuration > maxDuration) break;
      if (hasStoryboardTrackHardBoundary(moved, next.items[0])) break;
      segment.items.pop();
      next.items.unshift(moved);
      refreshSegmentDuration(segment);
      refreshSegmentDuration(next);
    }

    const previous = segments[index - 1];
    while (previous && segment.items.length > 1 && segment.baseTrack === previous.baseTrack && segmentHasDialogue(previous)) {
      const moved = segment.items[0];
      const movedDuration = normalizeStoryboardDuration(moved.duration);
      if (previous.duration + movedDuration > maxDuration) break;
      if (hasStoryboardTrackHardBoundary(previous.items[previous.items.length - 1], moved)) break;
      segment.items.shift();
      previous.items.push(moved);
      refreshSegmentDuration(segment);
      refreshSegmentDuration(previous);
    }
  }

  // Final pass: when source material has spoken lines, do not leave a whole
  // video segment silent merely because the visual setup is long. Merge the
  // silent run into the closest spoken segment and cap the generated video
  // duration; downstream prompt generation compresses the visual beats.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segmentHasDialogue(segment)) continue;

    const next = segments[index + 1];
    if (next && segment.baseTrack === next.baseTrack && segmentHasDialogue(next) && !hasStoryboardTrackHardBoundary(segment.items[segment.items.length - 1], next.items[0])) {
      next.items = [...segment.items, ...next.items];
      refreshSegmentDurationCapped(next, maxDuration);
      segments.splice(index, 1);
      index -= 1;
      continue;
    }

    const previous = segments[index - 1];
    if (previous && segment.baseTrack === previous.baseTrack && segmentHasDialogue(previous) && !hasStoryboardTrackHardBoundary(previous.items[previous.items.length - 1], segment.items[0])) {
      previous.items = [...previous.items, ...segment.items];
      refreshSegmentDurationCapped(previous, maxDuration);
      segments.splice(index, 1);
      index -= 1;
    }
  }

  return segments.filter((segment) => segment.items.length > 0);
}
