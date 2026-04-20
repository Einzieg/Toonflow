export interface StoryboardAssetProjectAsset {
  id?: number | null;
  name?: string | null;
  type?: string | null;
}

export interface StoryboardAssetNormalizationInput {
  associateAssetsIds?: number[] | null;
  prompt?: string | null;
  videoDesc?: string | null;
}

type NormalizedAssetType = "role" | "scene" | "tool" | null;

interface ExtractedStoryboardAssetRef {
  order: number;
  name: string;
  type: NormalizedAssetType;
}

const PROMPT_ASSET_REF_RE = /@图(\d+)\s*为\s*([^@\n]+?)(角色|场景|道具)(?=[,，。.;；\s]|$)/g;
const VIDEO_DESC_ASSET_LIST_RE = /关联资产(?:名称)?[:：]\s*(\[[^\]]+\])/;
const VIDEO_DESC_ASSET_IDS_RE = /关联资产ID[:：]\s*\[([^\]]+)\]/;

function normalizeAssetType(rawType?: string | null): NormalizedAssetType {
  const value = String(rawType ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "role" || value === "character" || rawType === "角色") return "role";
  if (value === "scene" || rawType === "场景") return "scene";
  if (value === "tool" || value === "prop" || rawType === "道具") return "tool";
  return null;
}

function normalizeAssetLookupName(rawName: string): string {
  return rawName
    .trim()
    .replace(/['"`“”‘’]/g, "")
    .replace(/[（）()【】\[\]《》<>]/g, "")
    .replace(/[，,。.:：;；、]/g, "")
    .replace(/[-_]/g, "")
    .replace(/\s+/g, "")
    .replace(/参考图|图片|图像/g, "")
    .replace(/夜景|日景|晨景|黄昏|白天|夜晚/g, "")
    .replace(/^(角色|场景|道具)/g, "")
    .replace(/(角色|场景|道具)$/g, "");
}

function dedupeIds(ids: Array<number | null | undefined>): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  ids.forEach((id) => {
    if (!Number.isInteger(id) || id == null || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  });
  return result;
}

function parseLooseStringList(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed.replace(/'/g, "\""));
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to tolerant parsing.
  }
  return trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/[，,]/)
    .map((item) => item.replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

function parseNumberList(rawValue?: string | null): number[] {
  if (!rawValue) return [];
  return dedupeIds(
    rawValue
      .split(/[，,]/)
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item)),
  );
}

function extractPromptAssetRefs(prompt?: string | null): ExtractedStoryboardAssetRef[] {
  if (!prompt) return [];
  const refs: ExtractedStoryboardAssetRef[] = [];
  for (const match of prompt.matchAll(PROMPT_ASSET_REF_RE)) {
    const order = Number(match[1]);
    const name = String(match[2] ?? "").trim();
    const type = normalizeAssetType(match[3]);
    if (!name || !Number.isFinite(order)) continue;
    refs.push({ order, name, type });
  }
  return refs.sort((a, b) => a.order - b.order);
}

function extractVideoDescAssetRefs(videoDesc?: string | null): ExtractedStoryboardAssetRef[] {
  if (!videoDesc) return [];
  const match = videoDesc.match(VIDEO_DESC_ASSET_LIST_RE);
  if (!match?.[1]) return [];
  return parseLooseStringList(match[1]).map((name, index) => ({
    order: index + 1,
    name,
    type: null,
  }));
}

function extractVideoDescAssetIds(videoDesc?: string | null): number[] {
  const match = videoDesc?.match(VIDEO_DESC_ASSET_IDS_RE);
  return parseNumberList(match?.[1]);
}

function resolveAssetIdByRef(ref: ExtractedStoryboardAssetRef, projectAssets: StoryboardAssetProjectAsset[]): number | null {
  const refName = normalizeAssetLookupName(ref.name);
  if (!refName) return null;

  let bestMatch: { id: number; score: number } | null = null;
  projectAssets.forEach((asset) => {
    if (!Number.isInteger(asset.id) || !asset.name) return;

    const assetType = normalizeAssetType(asset.type);
    if (ref.type && assetType && ref.type !== assetType) return;

    const assetName = normalizeAssetLookupName(asset.name);
    if (!assetName) return;

    let score = 0;
    if (assetName === refName) {
      score += 1000;
    } else if (refName.includes(assetName) || assetName.includes(refName)) {
      score += 500 - Math.abs(refName.length - assetName.length);
    }

    if (score <= 0) return;
    if (ref.type && assetType === ref.type) score += 100;
    score += Math.min(refName.length, assetName.length);

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { id: asset.id, score };
    }
  });

  return bestMatch?.id ?? null;
}

export function normalizeStoryboardAssociateAssets(
  input: StoryboardAssetNormalizationInput,
  projectAssets: StoryboardAssetProjectAsset[],
): number[] {
  const assetIdSet = new Set<number>(
    projectAssets
      .map((asset) => asset.id)
      .filter((assetId): assetId is number => Number.isInteger(assetId)),
  );

  const validExistingIds = dedupeIds(
    (input.associateAssetsIds ?? []).filter((assetId): assetId is number => Number.isInteger(assetId) && assetIdSet.has(assetId)),
  );

  const promptResolvedIds = dedupeIds(extractPromptAssetRefs(input.prompt).map((ref) => resolveAssetIdByRef(ref, projectAssets)));
  if (promptResolvedIds.length) {
    const hasInvalidExistingIds = dedupeIds(input.associateAssetsIds ?? []).length !== validExistingIds.length;
    const hasPromptConflict = promptResolvedIds.some((assetId, index) => validExistingIds[index] !== assetId);
    if (hasInvalidExistingIds || hasPromptConflict || promptResolvedIds.length >= validExistingIds.length) {
      return promptResolvedIds;
    }
  }

  const videoDescResolvedIds = dedupeIds(extractVideoDescAssetRefs(input.videoDesc).map((ref) => resolveAssetIdByRef(ref, projectAssets)));
  if (videoDescResolvedIds.length) {
    return videoDescResolvedIds;
  }

  const videoDescAssetIds = dedupeIds(extractVideoDescAssetIds(input.videoDesc).filter((assetId) => assetIdSet.has(assetId)));
  if (videoDescAssetIds.length) {
    return videoDescAssetIds;
  }

  return validExistingIds;
}
