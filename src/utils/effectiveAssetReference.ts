import u from "@/utils";

export interface EffectiveAssetReference {
  id: number;
  originalAssetId: number;
  assetsId: number | null;
  name: string;
  baseName: string;
  type: string;
  imageId: number | null;
  filePath: string | null;
  describe?: string | null;
  volcengineAssetUri?: string | null;
  parentVolcengineAssetUri?: string | null;
  storyboardId?: number;
}

interface AssetRow {
  id: number;
  assetsId?: number | null;
  name?: string | null;
  parentName?: string | null;
  type?: string | null;
  imageId?: number | null;
  filePath?: string | null;
  describe?: string | null;
  volcengineAssetUri?: string | null;
  parentVolcengineAssetUri?: string | null;
}

function formatAssetName(row: AssetRow) {
  const name = String(row.name || "").trim();
  const parentName = String(row.parentName || "").trim();
  if (!parentName || !name || name.includes(parentName)) return name || parentName;
  return `${parentName}-${name}`;
}

async function getPreferredRoleDerivativeMap(parentRoleIds: number[]) {
  if (!parentRoleIds.length) return new Map<number, AssetRow>();

  const rows: AssetRow[] = await u
    .db("o_assets")
    .leftJoin("o_image", "o_image.id", "o_assets.imageId")
    .whereIn("o_assets.assetsId", parentRoleIds)
    .where("o_assets.type", "role")
    .whereNotNull("o_assets.imageId")
    .orderBy("o_assets.id", "asc")
    .select(
      "o_assets.id",
      "o_assets.assetsId",
      "o_assets.name",
      "o_assets.type",
      "o_assets.imageId",
      "o_assets.describe",
      "o_assets.volcengineAssetUri",
      "o_image.filePath",
    );

  const map = new Map<number, AssetRow>();
  for (const row of rows) {
    const parentId = Number(row.assetsId);
    if (!Number.isInteger(parentId) || map.has(parentId)) continue;
    map.set(parentId, row);
  }
  return map;
}

export async function resolveEffectiveAssetReferences(assetIds: number[]) {
  const normalizedIds = assetIds.filter((id) => Number.isInteger(id));
  if (!normalizedIds.length) return [];

  const rows: AssetRow[] = await u
    .db("o_assets")
    .leftJoin("o_image", "o_image.id", "o_assets.imageId")
    .leftJoin({ parentAsset: "o_assets" }, "o_assets.assetsId", "parentAsset.id")
    .whereIn("o_assets.id", normalizedIds)
    .select(
      "o_assets.id",
      "o_assets.assetsId",
      "o_assets.name",
      "parentAsset.name as parentName",
      "o_assets.type",
      "o_assets.imageId",
      "o_assets.describe",
      "o_assets.volcengineAssetUri",
      "parentAsset.volcengineAssetUri as parentVolcengineAssetUri",
      "o_image.filePath",
    );

  const rowMap = new Map(rows.map((row) => [Number(row.id), row]));
  const parentRoleIds = rows
    .filter((row) => row.type === "role" && row.assetsId == null)
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id));
  const derivativeMap = await getPreferredRoleDerivativeMap(parentRoleIds);

  return normalizedIds
    .map((originalAssetId) => {
      const row = rowMap.get(originalAssetId);
      if (!row) return null;
      const effectiveRow = row.type === "role" && row.assetsId == null ? derivativeMap.get(Number(row.id)) || row : row;
      const parentName = row.assetsId == null ? row.name : row.parentName;
      const name = effectiveRow.id !== row.id ? formatAssetName({ ...effectiveRow, parentName: row.name }) : formatAssetName(row);
      const baseName = String(parentName || row.name || effectiveRow.name || "").trim();

      return {
        id: Number(effectiveRow.id),
        originalAssetId,
        assetsId: effectiveRow.assetsId == null ? null : Number(effectiveRow.assetsId),
        name,
        baseName,
        type: String(effectiveRow.type || row.type || ""),
        imageId: effectiveRow.imageId == null ? null : Number(effectiveRow.imageId),
        filePath: effectiveRow.filePath || null,
        describe: effectiveRow.describe || row.describe || null,
        volcengineAssetUri: effectiveRow.volcengineAssetUri || row.volcengineAssetUri || null,
        parentVolcengineAssetUri: row.parentVolcengineAssetUri || null,
      } satisfies EffectiveAssetReference;
    })
    .filter((item): item is EffectiveAssetReference => item != null);
}

export async function resolveEffectiveStoryboardAssetReferences(storyboardIds: number[]) {
  const normalizedIds = storyboardIds.filter((id) => Number.isInteger(id));
  if (!normalizedIds.length) return [];

  const rows = await u
    .db("o_assets2Storyboard")
    .whereIn("storyboardId", normalizedIds)
    .orderBy("storyboardId", "asc")
    .orderBy("rowid", "asc")
    .select("storyboardId", "assetId");

  const assetIds = rows.map((row: any) => Number(row.assetId)).filter((id) => Number.isInteger(id));
  const effectiveRefs = await resolveEffectiveAssetReferences(assetIds);
  const queues = new Map<number, EffectiveAssetReference[]>();
  for (const ref of effectiveRefs) {
    if (!queues.has(ref.originalAssetId)) queues.set(ref.originalAssetId, []);
    queues.get(ref.originalAssetId)!.push(ref);
  }

  return rows
    .map((row: any) => {
      const assetId = Number(row.assetId);
      const ref = queues.get(assetId)?.shift();
      if (!ref) return null;
      return {
        ...ref,
        storyboardId: Number(row.storyboardId),
      };
    })
    .filter((item): item is EffectiveAssetReference & { storyboardId: number } => item != null);
}
