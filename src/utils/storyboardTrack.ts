export const MAX_TRACK_DURATION_SECONDS = 15;
export const GROK_VIDEO_SUPPORTED_DURATIONS = [6, 10] as const;
export const GROK_IMAGINE_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS = [6, 10, 15] as const;

type Nullable<T> = T | null | undefined;

export interface StoryboardTrackItem {
  id?: number;
  index?: Nullable<number>;
  track?: Nullable<string>;
  trackId?: Nullable<number>;
  duration?: Nullable<number | string>;
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
  // Treat them as auto so re-sync can merge adjacent storyboards by duration.
  if (!normalized || /^\d+$/.test(normalized)) return "__AUTO__";
  return normalized;
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

export function getGrokVideoSupportedDurations(model?: Nullable<string>, displayName?: Nullable<string>): number[] {
  return isGrokImagineVideo15PreviewModel(model, displayName) ? [...GROK_IMAGINE_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS] : [...GROK_VIDEO_SUPPORTED_DURATIONS];
}

export function resolveGrokVideoDuration(duration: Nullable<number | string>, model?: Nullable<string>, displayName?: Nullable<string>): number {
  const supportedDurations = getGrokVideoSupportedDurations(model, displayName);
  const value = sanitizeDurationValue(duration, supportedDurations[0]);
  return supportedDurations.find((item) => value <= item) ?? supportedDurations[supportedDurations.length - 1];
}

export function resolveVideoGenerationDuration(model: Nullable<string>, duration: Nullable<number | string>, displayName?: Nullable<string>): number {
  if (isGrokImagineVideoModel(model, displayName)) return resolveGrokVideoDuration(duration, model, displayName);
  return normalizeStoryboardDuration(duration);
}

export function normalizeVideoModelDurationMap<T extends { name?: string; modelName?: string; durationResolutionMap?: { duration: number[]; resolution: string[] }[] }>(model: T): T {
  if (!Array.isArray(model.durationResolutionMap)) return model;
  if (isGrokImagineVideoModel(model.modelName, model.name)) {
    return {
      ...model,
      durationResolutionMap: model.durationResolutionMap.map((item) => ({
        ...item,
        duration: getGrokVideoSupportedDurations(model.modelName, model.name),
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

    if (!currentSegment || currentSegment.baseTrack !== baseTrack || currentSegment.duration + duration > maxDuration) {
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

  return segments;
}
