export const MAX_TRACK_DURATION_SECONDS = 15;

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
  return normalized || "__AUTO__";
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
    currentSegment.duration = Number((currentSegment.duration + duration).toFixed(3));
  });

  return segments;
}
