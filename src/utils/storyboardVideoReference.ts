import crypto from "crypto";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { normalizeStoryboardDuration } from "@/utils/storyboardTrack";
import { resolveMaxShotDurationSeconds, type ShotPolicyContext } from "@/utils/shotPolicy";
import { mediaPromptSafetyInstruction } from "@/utils/promptSafety";

export type StoryboardVideoReferenceMode = "auto" | "singleComposite" | "multiImage";
export type ResolvedStoryboardVideoReferenceMode = "singleComposite" | "multiImage";

export interface ShotFrameSource {
  shotNo: number;
  sourceStoryboardId?: number;
  filePath: string;
  duration: number;
  visualObjective: string;
  actionUnit: string;
  cameraMove: string;
  shotSize: string;
  emotion: string;
  dialogue: string;
  scene?: string;
  characters?: string[];
  roleVoiceSettings?: CharacterVoiceSetting[];
  props?: string[];
  owned?: boolean;
}

export interface CharacterVoiceSetting {
  name: string;
  voiceProfile?: string | null;
  voiceTone?: string | null;
  speechRate?: string | null;
}

export interface ShotFrameManifestItem {
  shotNo: number;
  sourceStoryboardId?: number;
  filePath: string;
  label?: string;
  duration: number;
  hash: string;
  included: boolean;
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape";
  owned?: boolean;
}

export interface ShotTimelineItem {
  shotNo: number;
  start: number;
  end: number;
  duration: number;
  visualObjective: string;
  actionUnit: string;
  cameraMove: string;
  shotSize: string;
  emotion: string;
  dialogue: string;
}

export interface LockedNarrative {
  allowedCharacters: string[];
  roleVoiceSettings?: CharacterVoiceSetting[];
  allowedScenes: string[];
  allowedProps: string[];
  requiredBeats: string[];
  forbiddenAdditions: string[];
}

export interface StoryboardVideoReferenceResult {
  mode: ResolvedStoryboardVideoReferenceMode;
  videoReferencePath: string;
  referencePaths: string[];
  frameManifest: ShotFrameManifestItem[];
  shotTimeline: ShotTimelineItem[];
  lockedNarrative: LockedNarrative;
}

const PORTRAIT_FRAME_WIDTH = 480;
const PORTRAIT_FRAME_HEIGHT = 854;
const LANDSCAPE_FRAME_WIDTH = 854;
const LANDSCAPE_FRAME_HEIGHT = 480;
const REFERENCE_SHEET_GUTTER = 56;
const REFERENCE_SHEET_FRAME_BORDER = 8;
const REFERENCE_SHEET_BACKGROUND = "#f2f2f2";
export const DEFAULT_STORYBOARD_VIDEO_FORBIDDEN_ADDITIONS = [
  "不要出现新角色",
  "不要切换到未列出的场景",
  "不要出现未列出的道具",
  "不要出现字幕、标题卡、caption、对话气泡或任何可读文字",
  "不要出现怪物、爆炸、追车、打斗等剧本没有的内容",
  "不要改变角色服装、身份、年龄和发型",
  "不要把参考图中的故事板排版、边框、卡片结构、分隔槽、分隔线或编号渲染到视频里",
];

function normalizeText(value?: string | number | null) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePromptWhitespace(value: string) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getUtf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function takeFirstUtf8Bytes(value: string, maxBytes: number) {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = getUtf8Bytes(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function truncateByUtf8Bytes(value: string, maxBytes: number) {
  const text = normalizeText(value);
  if (!text || getUtf8Bytes(text) <= maxBytes) return text;
  return `${takeFirstUtf8Bytes(text, Math.max(0, maxBytes - 3)).trimEnd()}...`;
}

function stableHash(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function unique(values: string[]) {
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function getFrameLabel(shotNo: number) {
  return `F${String(shotNo || 0).padStart(2, "0")}`;
}

const DIGIT_SEGMENTS: Record<string, Array<"a" | "b" | "c" | "d" | "e" | "f" | "g">> = {
  "0": ["a", "b", "c", "d", "e", "f"],
  "1": ["b", "c"],
  "2": ["a", "b", "d", "e", "g"],
  "3": ["a", "b", "c", "d", "g"],
  "4": ["b", "c", "f", "g"],
  "5": ["a", "c", "d", "f", "g"],
  "6": ["a", "c", "d", "e", "f", "g"],
  "7": ["a", "b", "c"],
  "8": ["a", "b", "c", "d", "e", "f", "g"],
  "9": ["a", "b", "c", "d", "f", "g"],
};

function svgRect(x: number, y: number, width: number, height: number) {
  const rx = Math.max(1, Math.min(width, height) * 0.35);
  return `<rect x="${Number(x.toFixed(2))}" y="${Number(y.toFixed(2))}" width="${Number(width.toFixed(2))}" height="${Number(height.toFixed(2))}" rx="${Number(rx.toFixed(2))}" fill="#fff"/>`;
}

function renderSegmentGlyph(char: string, x: number, y: number, scale: number) {
  const t = 4 * scale;
  const segments = {
    a: [3 * scale, 0, 12 * scale, t],
    b: [15 * scale, 3 * scale, t, 10 * scale],
    c: [15 * scale, 17 * scale, t, 10 * scale],
    d: [3 * scale, 27 * scale, 12 * scale, t],
    e: [0, 17 * scale, t, 10 * scale],
    f: [0, 3 * scale, t, 10 * scale],
    g: [3 * scale, 13.5 * scale, 12 * scale, t],
  } as const;

  if (char.toUpperCase() === "F") {
    return [
      svgRect(x + scale, y, 14 * scale, t),
      svgRect(x + scale, y, t, 30 * scale),
      svgRect(x + scale, y + 13.5 * scale, 12 * scale, t),
    ].join("");
  }

  return (DIGIT_SEGMENTS[char] || [])
    .map((segment) => {
      const [sx, sy, sw, sh] = segments[segment];
      return svgRect(x + sx, y + sy, sw, sh);
    })
    .join("");
}

function renderLabelGlyphs(label: string, x: number, y: number, scale: number, spacing: number) {
  return Array.from(label)
    .map((char, index) => renderSegmentGlyph(char, x + index * (18 * scale + spacing), y, scale))
    .join("");
}

function buildFrameLabelSvg(width: number, height: number, label: string) {
  const badgeHeight = Math.min(46, Math.max(34, Math.floor(height * 0.055)));
  const scale = (badgeHeight - 14) / 30;
  const spacing = 4 * scale;
  const labelWidth = label.length * 18 * scale + Math.max(0, label.length - 1) * spacing;
  const badgeWidth = Math.ceil(Math.min(132, Math.max(82, labelWidth + 24)));
  const glyphX = 12 + (badgeWidth - labelWidth) / 2;
  const glyphY = 12 + (badgeHeight - 30 * scale) / 2;
  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="12" y="12" width="${badgeWidth}" height="${badgeHeight}" rx="10" fill="#000" fill-opacity="0.74"/>
  ${renderLabelGlyphs(label, glyphX, glyphY, scale, spacing)}
</svg>`);
}

export function getMaxReferenceImages(modelDetail: any): number {
  const explicit = Number(modelDetail?.maxReferenceImages ?? modelDetail?.maxImageReferences);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);

  if (modelDetail?.referenceImageMode === "multiple") return 99;
  if (modelDetail?.referenceImageMode === "single") return 1;

  const mode = modelDetail?.mode;
  if (Array.isArray(mode)) {
    let max = 0;
    const scan = (value: any) => {
      if (typeof value === "string") {
        const match = value.match(/^imageReference:(\d+)$/);
        if (match) max = Math.max(max, Number(match[1]));
        if (value === "singleImage") max = Math.max(max, 1);
      } else if (Array.isArray(value)) {
        value.forEach(scan);
      }
    };
    mode.forEach(scan);
    if (max > 0) return max;
  }

  return 1;
}

export function resolveStoryboardVideoReferenceMode(
  modelDetail: any,
  requested: StoryboardVideoReferenceMode = "auto",
): ResolvedStoryboardVideoReferenceMode {
  if (requested === "singleComposite") return "singleComposite";
  if (requested === "multiImage") return getMaxReferenceImages(modelDetail) > 1 ? "multiImage" : "singleComposite";
  return "singleComposite";
}

export function buildShotTimeline(frames: ShotFrameSource[]): ShotTimelineItem[] {
  let cursor = 0;
  return frames.map((frame) => {
    const duration = normalizeStoryboardDuration(frame.duration);
    const start = Number(cursor.toFixed(3));
    const end = Number((cursor + duration).toFixed(3));
    cursor = end;
    return {
      shotNo: frame.shotNo,
      start,
      end,
      duration,
      visualObjective: normalizeText(frame.visualObjective),
      actionUnit: normalizeText(frame.actionUnit),
      cameraMove: normalizeText(frame.cameraMove),
      shotSize: normalizeText(frame.shotSize),
      emotion: normalizeText(frame.emotion),
      dialogue: normalizeText(frame.dialogue) || "无台词",
    };
  });
}

export function buildLockedNarrative(frames: ShotFrameSource[]): LockedNarrative {
  const roleVoiceSettings = uniqueRoleVoiceSettings(frames.flatMap((frame) => frame.roleVoiceSettings || []));
  return {
    allowedCharacters: unique(frames.flatMap((frame) => frame.characters || [])),
    roleVoiceSettings,
    allowedScenes: unique(frames.map((frame) => frame.scene || "")),
    allowedProps: unique(frames.flatMap((frame) => frame.props || [])),
    requiredBeats: unique(frames.map((frame) => frame.visualObjective || frame.actionUnit || "")),
    forbiddenAdditions: DEFAULT_STORYBOARD_VIDEO_FORBIDDEN_ADDITIONS,
  };
}

function hasVoiceSetting(item: CharacterVoiceSetting) {
  return Boolean(normalizeText(item.voiceProfile) || normalizeText(item.voiceTone) || normalizeText(item.speechRate));
}

function uniqueRoleVoiceSettings(settings: CharacterVoiceSetting[]) {
  const map = new Map<string, CharacterVoiceSetting>();
  for (const item of settings) {
    const name = normalizeText(item.name);
    if (!name || !hasVoiceSetting(item)) continue;
    const existing = map.get(name);
    map.set(name, {
      name,
      voiceProfile: normalizeText(existing?.voiceProfile) || normalizeText(item.voiceProfile) || null,
      voiceTone: normalizeText(existing?.voiceTone) || normalizeText(item.voiceTone) || null,
      speechRate: normalizeText(existing?.speechRate) || normalizeText(item.speechRate) || null,
    });
  }
  return Array.from(map.values());
}

function renderRoleVoiceSettings(settings?: CharacterVoiceSetting[]) {
  const rows = (settings || []).filter(hasVoiceSetting);
  if (!rows.length) return "No specific character voice settings.";
  return rows
    .map((item, index) => {
      const parts = [
        normalizeText(item.voiceProfile) ? `voice: ${normalizeText(item.voiceProfile)}` : "",
        normalizeText(item.voiceTone) ? `tone: ${normalizeText(item.voiceTone)}` : "",
        normalizeText(item.speechRate) ? `speech rate: ${normalizeText(item.speechRate)}` : "",
      ].filter(Boolean);
      return `${index + 1}. ${item.name}: ${parts.join("; ")}.`;
    })
    .join("\n");
}

interface NormalizedFrameImage {
  buffer: Buffer;
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  label: string;
}

async function normalizeFrameImage(filePath: string, label: string): Promise<NormalizedFrameImage> {
  const source = await u.oss.getFile(filePath);
  const metadata = await sharp(source, { failOn: "none" }).rotate().metadata();
  const orientation = Number(metadata.width || 0) > Number(metadata.height || 0) ? "landscape" : "portrait";
  const width = orientation === "landscape" ? LANDSCAPE_FRAME_WIDTH : PORTRAIT_FRAME_WIDTH;
  const height = orientation === "landscape" ? LANDSCAPE_FRAME_HEIGHT : PORTRAIT_FRAME_HEIGHT;
  const buffer = await sharp(source, { failOn: "none" })
    .rotate()
    .resize(width, height, {
      fit: "contain",
      background: "#000000",
      withoutEnlargement: false,
    })
    .composite([{ input: buildFrameLabelSvg(width, height, label), left: 0, top: 0 }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return { buffer, width, height, orientation, label };
}

function resolveSheetLayout(frames: NormalizedFrameImage[]) {
  const portraitCount = frames.filter((item) => item.orientation === "portrait").length;
  const sheetDirection: "horizontal" | "vertical" = portraitCount >= frames.length - portraitCount ? "horizontal" : "vertical";
  const cellWidth = Math.max(...frames.map((item) => item.width));
  const cellHeight = Math.max(...frames.map((item) => item.height));
  const count = frames.length;
  let columns = 1;
  let rows = count;

  if (sheetDirection === "horizontal") {
    columns = Math.max(1, Math.ceil(Math.sqrt((count * cellHeight) / cellWidth)));
    rows = Math.ceil(count / columns);
    while (columns * cellWidth < rows * cellHeight && columns < count) {
      columns += 1;
      rows = Math.ceil(count / columns);
    }
  } else {
    rows = Math.max(1, Math.ceil(Math.sqrt((count * cellWidth) / cellHeight)));
    columns = Math.ceil(count / rows);
    while (rows * cellHeight < columns * cellWidth && rows < count) {
      rows += 1;
      columns = Math.ceil(count / rows);
    }
  }

  return { columns, rows, cellWidth, cellHeight, sheetDirection };
}

function svgNum(value: number) {
  return Number(value.toFixed(2));
}

function buildReferenceSheetOverlaySvg(
  width: number,
  height: number,
  layout: {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    placements: Array<{ left: number; top: number; width: number; height: number }>;
  },
) {
  const dividerElements: string[] = [];

  for (let column = 1; column < layout.columns; column += 1) {
    const dividerLeft = REFERENCE_SHEET_GUTTER + column * layout.cellWidth + (column - 1) * REFERENCE_SHEET_GUTTER;
    const center = dividerLeft + REFERENCE_SHEET_GUTTER / 2;
    dividerElements.push(
      `<rect x="${svgNum(dividerLeft)}" y="0" width="${REFERENCE_SHEET_GUTTER}" height="${height}" fill="#ffffff" opacity="0.9"/>`,
      `<rect x="${svgNum(center - 13)}" y="0" width="4" height="${height}" fill="#111111" opacity="0.44"/>`,
      `<rect x="${svgNum(center - 3)}" y="0" width="6" height="${height}" fill="#111111" opacity="0.9"/>`,
      `<rect x="${svgNum(center + 9)}" y="0" width="4" height="${height}" fill="#111111" opacity="0.44"/>`,
    );
  }

  for (let row = 1; row < layout.rows; row += 1) {
    const dividerTop = REFERENCE_SHEET_GUTTER + row * layout.cellHeight + (row - 1) * REFERENCE_SHEET_GUTTER;
    const center = dividerTop + REFERENCE_SHEET_GUTTER / 2;
    dividerElements.push(
      `<rect x="0" y="${svgNum(dividerTop)}" width="${width}" height="${REFERENCE_SHEET_GUTTER}" fill="#ffffff" opacity="0.9"/>`,
      `<rect x="0" y="${svgNum(center - 13)}" width="${width}" height="4" fill="#111111" opacity="0.44"/>`,
      `<rect x="0" y="${svgNum(center - 3)}" width="${width}" height="6" fill="#111111" opacity="0.9"/>`,
      `<rect x="0" y="${svgNum(center + 9)}" width="${width}" height="4" fill="#111111" opacity="0.44"/>`,
    );
  }

  const frameElements = layout.placements
    .map((placement) => {
      const x = placement.left - REFERENCE_SHEET_FRAME_BORDER;
      const y = placement.top - REFERENCE_SHEET_FRAME_BORDER;
      const rectWidth = placement.width + REFERENCE_SHEET_FRAME_BORDER * 2;
      const rectHeight = placement.height + REFERENCE_SHEET_FRAME_BORDER * 2;
      return [
        `<rect x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(rectWidth)}" height="${svgNum(rectHeight)}" fill="none" stroke="#111111" stroke-width="8"/>`,
        `<rect x="${svgNum(x + 8)}" y="${svgNum(y + 8)}" width="${svgNum(rectWidth - 16)}" height="${svgNum(rectHeight - 16)}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.86"/>`,
      ].join("");
    })
    .join("");

  return Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  ${dividerElements.join("\n  ")}
  ${frameElements}
</svg>`);
}

async function composeSingleReferenceImage(projectId: number, frames: NormalizedFrameImage[]) {
  const { columns, rows, cellWidth, cellHeight } = resolveSheetLayout(frames);
  const width = columns * cellWidth + (columns + 1) * REFERENCE_SHEET_GUTTER;
  const height = rows * cellHeight + (rows + 1) * REFERENCE_SHEET_GUTTER;
  const placements = frames.map((frame, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellLeft = REFERENCE_SHEET_GUTTER + column * (cellWidth + REFERENCE_SHEET_GUTTER);
    const cellTop = REFERENCE_SHEET_GUTTER + row * (cellHeight + REFERENCE_SHEET_GUTTER);
    return {
      left: cellLeft + Math.floor((cellWidth - frame.width) / 2),
      top: cellTop + Math.floor((cellHeight - frame.height) / 2),
      width: frame.width,
      height: frame.height,
    };
  });
  const canvas = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: REFERENCE_SHEET_BACKGROUND,
    },
  });
  const output = await canvas
    .composite(
      [
        ...frames.map((frame, index) => ({
          input: frame.buffer,
          left: placements[index].left,
          top: placements[index].top,
        })),
        {
          input: buildReferenceSheetOverlaySvg(width, height, {
            columns,
            rows,
            cellWidth,
            cellHeight,
            placements,
          }),
          left: 0,
          top: 0,
        },
      ],
    )
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  const videoReferencePath = `/${projectId}/storyboardVideoReference/${uuidv4()}.jpg`;
  await u.oss.writeFile(videoReferencePath, output);
  return videoReferencePath;
}

export async function createStoryboardVideoReference(input: {
  projectId: number;
  frames: ShotFrameSource[];
  modelDetail?: any;
  requestedMode?: StoryboardVideoReferenceMode;
}): Promise<StoryboardVideoReferenceResult> {
  if (!input.frames.length) throw new Error("缺少可用于视频参考的镜头帧");
  const frames = input.frames;
  const mode = resolveStoryboardVideoReferenceMode(input.modelDetail, input.requestedMode || "auto");
  const normalizedFrames = await Promise.all(frames.map((frame) => normalizeFrameImage(frame.filePath, getFrameLabel(frame.shotNo))));
  const frameManifest = frames.map((frame, index) => ({
    shotNo: frame.shotNo,
    sourceStoryboardId: frame.sourceStoryboardId,
    filePath: frame.filePath,
    label: normalizedFrames[index].label,
    duration: normalizeStoryboardDuration(frame.duration),
    hash: stableHash(normalizedFrames[index].buffer),
    included: true,
    width: normalizedFrames[index].width,
    height: normalizedFrames[index].height,
    orientation: normalizedFrames[index].orientation,
    owned: !!frame.owned,
  }));
  const shotTimeline = buildShotTimeline(frames);
  const lockedNarrative = buildLockedNarrative(frames);
  const videoReferencePath = await composeSingleReferenceImage(input.projectId, normalizedFrames);

  return {
    mode,
    videoReferencePath,
    referencePaths: mode === "multiImage" ? frames.map((frame) => frame.filePath).slice(0, getMaxReferenceImages(input.modelDetail)) : [videoReferencePath],
    frameManifest,
    shotTimeline,
    lockedNarrative,
  };
}

export function fitStoryboardVideoReferenceDuration(
  result: StoryboardVideoReferenceResult,
  targetDuration: number,
): StoryboardVideoReferenceResult {
  const target = Number(targetDuration);
  if (!Number.isFinite(target) || target <= 0 || !result.shotTimeline.length) return result;

  const total = result.shotTimeline.reduce((sum, item) => sum + Number(item.duration || 0), 0);
  if (!Number.isFinite(total) || total <= 0 || Math.abs(total - target) <= 0.001) return result;

  let cursor = 0;
  const shotTimeline = result.shotTimeline.map((item, index) => {
    const isLast = index === result.shotTimeline.length - 1;
    const remainingSlots = result.shotTimeline.length - index - 1;
    const maxCurrentDuration = Math.max(0.001, target - cursor - remainingSlots * 0.001);
    const rawDuration = isLast ? target - cursor : (Number(item.duration || 0) / total) * target;
    const duration = Math.min(Math.max(0.001, rawDuration), maxCurrentDuration);
    const roundedDuration = Number(duration.toFixed(3));
    const start = Number(cursor.toFixed(3));
    const end = Number((isLast ? Math.max(start + 0.001, target) : cursor + roundedDuration).toFixed(3));
    cursor = end;
    return {
      ...item,
      start,
      end,
      duration: Number((end - start).toFixed(3)),
    };
  });

  return {
    ...result,
    frameManifest: result.frameManifest.map((item, index) => ({
      ...item,
      duration: shotTimeline[index]?.duration ?? item.duration,
    })),
    shotTimeline,
  };
}

export function validateStoryboardVideoReferenceResult(
  result: StoryboardVideoReferenceResult,
  targetDuration: number,
  policyContext?: ShotPolicyContext | null,
): string[] {
  const violations: string[] = [];
  const maxShotDuration = resolveMaxShotDurationSeconds(policyContext);
  if (!result.videoReferencePath) violations.push("缺少 videoReferencePath");
  if (!result.frameManifest.length) violations.push("frameManifest 为空");
  if (!result.shotTimeline.length) violations.push("shotTimeline 为空");
  if (!result.lockedNarrative.requiredBeats.length) violations.push("lockedNarrative 缺少 requiredBeats");
  const total = result.shotTimeline.reduce((sum, item) => sum + item.duration, 0);
  const tolerance = Math.max(0.5, targetDuration * 0.1);
  if (Number.isFinite(targetDuration) && targetDuration > 0 && Math.abs(total - targetDuration) > tolerance) {
    violations.push(`shotTimeline 总时长 ${Number(total.toFixed(3))}s 与目标 ${targetDuration}s 偏差超过 ${Number(tolerance.toFixed(3))}s`);
  }
  result.shotTimeline.forEach((item) => {
    if (!item.actionUnit) violations.push(`镜头 ${item.shotNo} 缺少 actionUnit`);
    if (item.duration > maxShotDuration) {
      violations.push(`镜头 ${item.shotNo} 时长 ${item.duration}s 超过 ${maxShotDuration}s，必须拆成更多故事板镜头`);
    }
  });
  if (result.mode === "singleComposite" && result.referencePaths.length !== 1) {
    violations.push("singleComposite 模式只能传一张合成参考图");
  }
  return violations;
}

function isSilentDialogue(dialogue?: string) {
  const text = normalizeText(dialogue);
  return !text || text === "无台词" || /^无(?:对白|台词|配音)$/i.test(text);
}

function countDialogueChars(value?: string | null) {
  return normalizeText(value)
    .replace(/(?:^|[；;。.!！?？])[^；;。.!！?？：:]{1,16}[：:]/g, "")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
}

function getRequiredAudioLines(result: StoryboardVideoReferenceResult) {
  return unique(result.shotTimeline.map((item) => item.dialogue).filter((dialogue) => !isSilentDialogue(dialogue)));
}

function buildLowDialogueHandlingPlan(result: StoryboardVideoReferenceResult) {
  return result.shotTimeline
    .flatMap((item) => {
      const duration = normalizeStoryboardDuration(item.duration);
      const dialogue = isSilentDialogue(item.dialogue) ? "" : item.dialogue;
      const charCount = countDialogueChars(dialogue);
      const minChars = Math.ceil(duration * 2);
      if (!duration || charCount >= minChars) return [];
      return [{
        shotNo: item.shotNo,
        time: `${item.start}-${item.end}s`,
        duration,
        charCount,
        existingDialogue: dialogue || "无台词",
        visualObjective: item.visualObjective,
        actionUnit: item.actionUnit,
        emotion: item.emotion,
      }];
    });
}

function renderLowDialogueHandlingPlan(rows: Array<Record<string, any>>) {
  if (!rows.length) return "None.";
  return rows
    .map((row) => {
      return [
        `Shot ${row.shotNo} (${row.time}, ${row.duration}s)`,
        `current dialogue chars=${row.charCount}`,
        `existing=${row.existingDialogue}`,
        "handling=do not add dialogue; fill timing with action progression, facial performance, pauses, ambient sound, BGM, and camera motion",
        `plot basis=${truncateByUtf8Bytes(`${row.visualObjective}; ${row.actionUnit}; ${row.emotion}`, 220)}`,
      ].join("; ");
    })
    .join("\n");
}

function renderMotionAndPerformanceDirection() {
  return [
    "Generation direction:",
    "The timeline and reference panels are key beats, not frozen stills. Generate a continuous cinematic performance across the full duration.",
    "For each time range, infer natural in-between motion from the visual/action/camera/emotion fields: body movement, gaze shift, facial micro-expression, hand gesture, stance change, prop contact, cloth movement, and camera movement.",
    "Characters and props must have cause-and-effect progression. If a prop is held, shown, handed over, raised, hidden, dropped, or touched in the beat, animate that interaction naturally and preserve prop continuity.",
    "Optimize staging, motion rhythm, camera easing, reaction beats, pauses, and dialogue delivery so the clip feels like filmed drama instead of a slide show.",
    "You may optimize performance and timing, but do not add new plot events, new characters, new props, subtitles, captions, readable text, or extra Mandarin dialogue.",
  ].join("\n");
}

function renderDialoguePerformanceDirection() {
  return [
    "Dialogue performance:",
    "All required Chinese Mandarin lines must be spoken by the correct character in the matching time range.",
    "Keep the required dialogue wording verbatim. Do not rewrite, summarize, translate, skip, or replace it.",
    "Do not add dialogue, inner monologue, voiceover, narration, or system broadcast lines that are not present in the required audio list.",
    "For silent or low-dialogue shots, fill the time with performance, pauses, ambience, BGM, and camera motion while keeping mouths closed unless a required line is being spoken.",
    "For every spoken line, specify the speaker, dialogue type, exact Chinese text, voice texture, emotion, tone, speech rate, breath, pause length, volume, stress, mouth movement sync, and interaction with the character's body language.",
    "For inner monologue or voiceover, keep the mouth closed/no lip movement unless the line is explicitly spoken aloud.",
    "For characters that remain silent after the supplement decision, explicitly state silent performance and no mouth movement.",
    "If a line is too long for the visual beat, keep the line complete and use natural fast-but-clear delivery rather than dropping words.",
  ].join("\n");
}

function stripCodeFence(value: string) {
  return String(value || "")
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildAiPromptGenerationInput(input: {
  result: StoryboardVideoReferenceResult;
  targetDuration: number;
  model: string;
  modelDetail?: any;
  project?: any;
  maxBytes: number;
  previousIssue?: string;
}) {
  const { result, targetDuration, model, modelDetail, project, maxBytes, previousIssue } = input;
  const requiredAudioLines = getRequiredAudioLines(result);
  const lowDialogueHandlingPlan = buildLowDialogueHandlingPlan(result);
  const lock = result.lockedNarrative;
  const targetChars = Math.max(650, Math.min(1800, Math.floor(maxBytes * 0.42)));
  const timeline = result.shotTimeline.map((item) => ({
    time: `${item.start}-${item.end}s`,
    visualObjective: item.visualObjective,
    actionUnit: item.actionUnit,
    camera: `${item.shotSize}, ${item.cameraMove}`,
    emotion: item.emotion,
    dialogue: isSilentDialogue(item.dialogue) ? "无台词" : item.dialogue,
  }));

  return [
    "你要为图生视频模型生成最终可直接提交的 prompt。不要做模板填空，要先理解故事板参考帧、镜头时间轴、角色动作、道具互动、情绪和台词，再改写成自然、连续、导演式的视频生成提示词。",
    "",
    "输出要求：",
    "- 只输出最终 prompt 文本，不要解释，不要 Markdown 代码块。",
    "- 画面、动作、镜头、节奏说明优先使用英文；已有台词、旁白、配音内容必须保持原始中文，不翻译、不改写、不省略。",
    `- 总时长必须是 ${targetDuration}s，按时间轴连续推进。`,
    `- 目标视频模型：${modelDetail?.name || modelDetail?.modelName || model}。`,
    `- 输出长度控制在约 ${targetChars} 个字符以内，宁可短，不要超长。`,
    "- 必须明确说明：输入图片是分离的故事板参考帧/参考图，不是要展示在视频中的完整画面；禁止把拼接图、边框、分隔线、编号、标签、字幕、caption、标题卡、对话气泡、任何可读文字渲染进视频。",
    "- 根据镜头时间轴自然推演角色/道具动作演进、视线、表情、肢体、衣物、道具接触、镜头运动和表演节奏，避免静态幻灯片感。",
    "- 不要把输入事实逐条展开成冗长清单；把它们压缩成可执行的视频导演提示词。",
    "- 可以优化运动节奏、停顿、台词语气、语速、口型同步和镜头衔接，但不能新增剧情事件、新角色、新道具、新场景或任何原分镜不存在的台词、OS、VO、旁白。",
    "- 如果有角色声线设定，必须写进对应角色的对白/配音表演要求；即使没有明确声线，也要根据角色身份、年龄、情绪为每句台词补足语气、语速、气息、停顿、重音、音量和口型同步状态。",
    "- 无台词或台词较少的镜头，不得补台词；必须用动作演进、表情、停顿、环境音、BGM 和镜头运动填满时长。",
    "- 每句中文台词必须写清 speaker、dialogue type、exact Mandarin line、voice/tone、speech rate、breath/pauses、volume/stress、lip-sync active；OS/VO 或最终保持沉默的角色必须写 mouth closed/no lip movement。",
    `- ${mediaPromptSafetyInstruction().replace(/\n/g, " ")}`,
    previousIssue ? `- 上一次输出问题：${previousIssue}。这次必须修正。` : "",
    "",
    "项目信息：",
    `项目名：${normalizeText(project?.name) || "未提供"}`,
    `项目类型：${normalizeText(project?.type) || normalizeText(project?.projectType) || "未提供"}`,
    `画风/风格：${normalizeText(project?.artStyle) || "未提供"}`,
    `导演手册：${truncateByUtf8Bytes(normalizeText(project?.directorManual), 700) || "未提供"}`,
    "",
    "参考图信息：",
    `reference mode: ${result.mode}`,
    "Attached visual reference is a separated shot reference sheet. Use panel content only as temporal visual reference; never render the sheet itself.",
    "",
    "镜头时间轴事实（必须覆盖，不要照抄成表格）：",
    JSON.stringify(timeline, null, 2),
    "",
    "必须原样说出的中文普通话台词：",
    requiredAudioLines.length ? requiredAudioLines.map((line, index) => `${index + 1}. ${line}`).join("\n") : "无台词或旁白。",
    "",
    "需按剧情补足中文台词的镜头：",
    renderLowDialogueHandlingPlan(lowDialogueHandlingPlan),
    "",
    "角色声线设定：",
    renderRoleVoiceSettings(lock.roleVoiceSettings),
    "",
    "叙事锁定：",
    `允许角色：${lock.allowedCharacters.join("、") || "未指定"}`,
    `允许场景：${lock.allowedScenes.join("、") || "未指定"}`,
    `允许道具：${lock.allowedProps.join("、") || "未指定"}`,
    `必须覆盖的剧情节拍：${lock.requiredBeats.join("；") || "按时间轴执行"}`,
    `禁止项：${lock.forbiddenAdditions.join("；")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function findMissingRequiredAudioLines(prompt: string, result: StoryboardVideoReferenceResult) {
  return getRequiredAudioLines(result).filter((line) => !String(prompt || "").includes(line));
}

function renderRequiredAudioAppendix(lines: string[]) {
  const normalized = lines.map(normalizeText).filter(Boolean);
  if (!normalized.length) return "";
  return [
    "Required Mandarin dialogue, speak verbatim, no subtitles:",
    ...normalized.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

function ensureRequiredAudioLines(prompt: string, result: StoryboardVideoReferenceResult) {
  const missing = findMissingRequiredAudioLines(prompt, result);
  if (!missing.length) return normalizePromptWhitespace(prompt);
  return normalizePromptWhitespace([prompt, renderRequiredAudioAppendix(missing)].filter(Boolean).join("\n\n"));
}

function compactAiPromptPreservingRequiredAudio(prompt: string, result: StoryboardVideoReferenceResult, maxBytes: number) {
  const requiredAudioLines = getRequiredAudioLines(result);
  const appendix = renderRequiredAudioAppendix(requiredAudioLines);
  const normalized = normalizePromptWhitespace(prompt);
  const withRequiredAudio = ensureRequiredAudioLines(normalized, result);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || getUtf8Bytes(withRequiredAudio) <= maxBytes) return withRequiredAudio;
  if (!appendix) return takeFirstUtf8Bytes(normalized, maxBytes).trimEnd();

  const separator = "\n\n";
  const reserveBytes = getUtf8Bytes(separator) + getUtf8Bytes(appendix);
  const bodyBudget = maxBytes - reserveBytes;
  if (bodyBudget <= 80) return takeFirstUtf8Bytes(appendix, maxBytes).trimEnd();

  const compactBody = takeFirstUtf8Bytes(normalized, bodyBudget).trimEnd();
  return normalizePromptWhitespace([compactBody, appendix].filter(Boolean).join(separator));
}

export async function generateStoryboardVideoReferencePromptWithAI(input: {
  result: StoryboardVideoReferenceResult;
  targetDuration: number;
  model: string;
  modelDetail?: any;
  project?: any;
  maxBytes: number;
}) {
  let previousIssue = "";
  let lastPrompt = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { text } = await u.Ai.Text("universalAi").invoke({
      system: [
        "你是短剧视频导演、视频生成提示词设计师和表演指导。",
        "你的任务不是套模板，而是把结构化故事板事实改写成可直接提交给图生视频模型的最终 prompt。",
        "你必须保留台词原文、时长、角色、场景、道具和禁忌项，并优化动作连续性、镜头调度、台词表演和视频模型可执行性。",
      ].join("\n"),
      prompt: buildAiPromptGenerationInput({ ...input, previousIssue }),
      maxOutputTokens: 1200,
    });
    const rawPrompt = normalizePromptWhitespace(stripCodeFence(String(text || "")));
    if (!rawPrompt) {
      previousIssue = "模型返回空 prompt";
      continue;
    }
    const prompt = ensureRequiredAudioLines(rawPrompt, input.result);
    lastPrompt = prompt;
    const missingAudioLines = findMissingRequiredAudioLines(prompt, input.result);
    if (missingAudioLines.length) {
      previousIssue = `缺少必须原样保留的中文台词：${missingAudioLines.join("；")}`;
      continue;
    }
    const promptBytes = getUtf8Bytes(prompt);
    if (Number.isFinite(input.maxBytes) && input.maxBytes > 0 && promptBytes > input.maxBytes) {
      previousIssue = `输出过长：${promptBytes} bytes，必须压缩到 ${input.maxBytes} bytes 以内`;
      continue;
    }
    return prompt;
  }
  const repairedPrompt = compactAiPromptPreservingRequiredAudio(lastPrompt, input.result, input.maxBytes);
  if (repairedPrompt && !findMissingRequiredAudioLines(repairedPrompt, input.result).length && getUtf8Bytes(repairedPrompt) <= input.maxBytes) {
    return repairedPrompt;
  }
  throw new Error(
    `故事板视频提示词 AI 生成失败：${previousIssue || "模型未返回有效 prompt"}${
      lastPrompt ? `；最后输出 ${getUtf8Bytes(lastPrompt)} bytes` : ""
    }`,
  );
}

export function renderStoryboardVideoReferencePrompt(result: StoryboardVideoReferenceResult, targetDuration: number) {
  const requiredAudioLines = getRequiredAudioLines(result);
  const lowDialogueHandlingPlan = buildLowDialogueHandlingPlan(result);
  const timeline = result.shotTimeline
    .map((item) => {
      const dialogue =
        !isSilentDialogue(item.dialogue)
          ? ` Required spoken Chinese Mandarin audio, verbatim: ${item.dialogue}. Do not omit this line and do not render it as subtitles.`
          : " No dialogue.";
      return `${item.start}-${item.end}s: ${item.visualObjective}; action: ${item.actionUnit}; camera: ${item.shotSize}, ${item.cameraMove}; emotion: ${item.emotion}.${dialogue}`;
    })
    .join("\n");
  const lock = result.lockedNarrative;
  return [
    `A ${targetDuration}-second cinematic video clip.`,
    "",
    "Visual reference:",
    "Use the attached visual-only shot sequence sheet as composition and continuity reference.",
    "The attached sheet is not a frame to display. It is a separated contact sheet: each bordered panel is one temporal reference frame.",
    "Use only the cinematic content inside each panel. Never show the full contact sheet, gutters, divider bars, frame borders, or panel layout in the output video.",
    "It contains ordered visual frames. Frame labels such as F01/F02 are sequence markers only and must not appear in the output video.",
    "No text, captions, subtitles, labels, title cards, or speech bubbles should appear in the output video.",
    mediaPromptSafetyInstruction(),
    "",
    renderMotionAndPerformanceDirection(),
    "",
    "Timeline:",
    timeline,
    "",
    "Required Chinese audio lines:",
    requiredAudioLines.length
      ? requiredAudioLines.map((line, index) => `${index + 1}. Speak verbatim in Chinese Mandarin: ${line}`).join("\n")
      : "No spoken dialogue or voiceover.",
    "",
    "Low-dialogue handling:",
    "Do not add dialogue, inner monologue, voiceover, narration, or system broadcast lines. For silent/low-dialogue ranges, fill timing with action progression, facial performance, pauses, ambience, BGM, and camera motion.",
    renderLowDialogueHandlingPlan(lowDialogueHandlingPlan),
    "",
    "Character voice settings:",
    renderRoleVoiceSettings(lock.roleVoiceSettings),
    "",
    renderDialoguePerformanceDirection(),
    "Apply each character voice setting to that character's spoken dialogue. Keep Mandarin pronunciation natural, with the specified tone, speech rate, breath, pauses, volume, stress, and lip-sync status.",
    "Do not summarize, translate, skip, or replace these audio lines. If timing is tight, prioritize these required audio lines over ambient sound.",
    "Do not show the dialogue as subtitles or any readable on-screen text.",
    "",
    "Locked narrative:",
    `Allowed characters: ${lock.allowedCharacters.join("、") || "none specified"}.`,
    `Allowed scenes: ${lock.allowedScenes.join("、") || "none specified"}.`,
    `Allowed props: ${lock.allowedProps.join("、") || "none specified"}.`,
    `Required beats: ${lock.requiredBeats.join("；")}.`,
    `Forbidden: ${lock.forbiddenAdditions.join("; ")}.`,
    "",
    "Audio rule: all spoken dialogue, voiceover, and character dubbing must be Chinese Mandarin.",
  ].join("\n");
}

export function renderCompactStoryboardVideoReferencePrompt(result: StoryboardVideoReferenceResult, targetDuration: number, fieldBytes = 96) {
  const requiredAudioLines = getRequiredAudioLines(result);
  const lowDialogueHandlingPlan = buildLowDialogueHandlingPlan(result);
  const audioIndex = new Map(requiredAudioLines.map((line, index) => [normalizeText(line), index + 1]));
  const timeline = result.shotTimeline
    .map((item) => {
      const lineNo = audioIndex.get(normalizeText(item.dialogue));
      const audio = lineNo ? `audio: speak required line ${lineNo} verbatim in Chinese.` : "audio: none.";
      return [
        `${item.start}-${item.end}s`,
        `visual: ${truncateByUtf8Bytes(item.visualObjective, fieldBytes) || "follow reference frame"}`,
        `action: ${truncateByUtf8Bytes(item.actionUnit, fieldBytes) || "follow reference frame"}`,
        `camera: ${truncateByUtf8Bytes(`${item.shotSize}, ${item.cameraMove}`, Math.max(48, Math.floor(fieldBytes * 0.75))) || "follow reference frame"}`,
        audio,
      ].join("; ");
    })
    .join("\n");
  const lock = result.lockedNarrative;
  return [
    `[Toonflow compact prompt: preserve all required audio lines and the attached video reference image.]`,
    `Create a ${targetDuration}-second cinematic video from the attached visual-only shot sequence sheet.`,
    "The reference image is a separated contact sheet, not a display frame. Use each panel as a temporal reference only.",
    "Frame labels such as F01/F02 are sequence markers only; do not render them into the video.",
    "Do not render the full contact sheet, gutters, divider bars, panel borders, subtitles, captions, labels, title cards, UI, watermarks, or any readable text.",
    mediaPromptSafetyInstruction(),
    "All spoken audio must be Chinese Mandarin.",
    "Generate continuous drama motion, not static slides. Infer natural character movement, prop interaction, facial performance, gaze, camera easing, and transition beats between panels.",
    "Optimize performance/timing only; do not add new plot events, characters, props, readable text, or extra Mandarin dialogue.",
    "",
    "Required Chinese Mandarin audio, speak verbatim in order. Do not skip, summarize, translate, or replace:",
    requiredAudioLines.length ? requiredAudioLines.map((line, index) => `${index + 1}. ${line}`).join("\n") : "No spoken dialogue or voiceover.",
    "",
    "Silent/low-dialogue ranges must stay silent unless a required line exists; fill timing with performance, ambience, BGM, and camera motion:",
    renderLowDialogueHandlingPlan(lowDialogueHandlingPlan),
    "",
    "Character voice settings:",
    renderRoleVoiceSettings(result.lockedNarrative.roleVoiceSettings),
    "For every spoken line, include speaker, exact Mandarin line, tone, speech rate, breath/pauses, volume/stress, and lip-sync active; silent/OS/VO lines must keep mouth closed/no lip movement.",
    "",
    "Timeline:",
    timeline,
    "",
    `Locked characters: ${truncateByUtf8Bytes(lock.allowedCharacters.join("、"), 240) || "none specified"}.`,
    `Locked scenes: ${truncateByUtf8Bytes(lock.allowedScenes.join("、"), 180) || "none specified"}.`,
    `Locked props: ${truncateByUtf8Bytes(lock.allowedProps.join("、"), 180) || "none specified"}.`,
    `Required beats: ${truncateByUtf8Bytes(lock.requiredBeats.join("; "), 360) || "follow the timeline only"}.`,
    "Forbidden: no new characters, scenes, props, story events, subtitles, readable text, storyboard layout, or speech bubbles.",
  ].join("\n");
}

export function limitStoryboardVideoReferencePrompt(
  prompt: string,
  result: StoryboardVideoReferenceResult,
  targetDuration: number,
  maxBytes: number,
) {
  const normalized = normalizePromptWhitespace(prompt);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || getUtf8Bytes(normalized) <= maxBytes) return normalized;

  for (const fieldBytes of [120, 96, 72, 48]) {
    const compact = normalizePromptWhitespace(renderCompactStoryboardVideoReferencePrompt(result, targetDuration, fieldBytes));
    if (getUtf8Bytes(compact) <= maxBytes) return compact;
  }

  const requiredAudioLines = getRequiredAudioLines(result);
  const timeline = result.shotTimeline
    .map((item) => {
      const lineIndex = requiredAudioLines.findIndex((line) => normalizeText(line) === normalizeText(item.dialogue));
      return `${item.start}-${item.end}s: ${truncateByUtf8Bytes(item.visualObjective || item.actionUnit, 42) || "follow ref"}; audio: ${
        lineIndex >= 0 ? `line ${lineIndex + 1}` : "none"
      }.`;
    })
    .join("\n");
  const minimal = normalizePromptWhitespace(
    [
      `Create a ${targetDuration}s cinematic video from the attached visual reference. No subtitles or readable text.`,
      "The reference is a separated contact sheet; do not show the full sheet, gutters, dividers, borders, or labels.",
      mediaPromptSafetyInstruction(),
      "Generate continuous character/prop motion and camera progression between reference beats. Optimize performance timing, but add no new story, characters, or props.",
      "If a beat is silent or below about 2 Chinese chars per second, add plot-consistent Chinese Mandarin dialogue/OS/VO to reach about 2-3 Chinese chars per second.",
      "Chinese Mandarin audio lines, speak verbatim in order:",
      requiredAudioLines.length ? requiredAudioLines.map((line, index) => `${index + 1}. ${line}`).join("\n") : "No spoken dialogue or voiceover.",
      "Character voice settings:",
      renderRoleVoiceSettings(result.lockedNarrative.roleVoiceSettings),
      "Timeline:",
      timeline,
      "No new characters, scenes, props, or story events.",
    ].join("\n"),
  );
  if (getUtf8Bytes(minimal) <= maxBytes) return minimal;
  return takeFirstUtf8Bytes(minimal, maxBytes).trimEnd();
}

export async function cleanupStoryboardVideoReferenceFiles(input: {
  videoReferencePath?: string | null;
  frameManifest?: string | null;
}) {
  const paths = new Set<string>();
  if (input.videoReferencePath) paths.add(input.videoReferencePath);
  try {
    const manifest = JSON.parse(input.frameManifest || "[]");
    if (Array.isArray(manifest)) {
      manifest.forEach((item) => {
        if (item?.owned && item?.filePath) paths.add(String(item.filePath));
      });
    }
  } catch {}

  await Promise.all(
    Array.from(paths).map(async (filePath) => {
      try {
        if (await u.oss.fileExists(filePath)) await u.oss.deleteFile(filePath);
      } catch (e) {
        console.warn("[storyboardVideoReference.cleanup] 清理文件失败:", filePath, u.error(e).message);
      }
    }),
  );
}
