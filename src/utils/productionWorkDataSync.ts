import u from "@/utils";

function parseWorkData(raw: unknown) {
  try {
    const data = JSON.parse(String(raw || "{}"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return null;
  }
}

export async function syncProductionScriptToWorkData(input: {
  projectId?: number | string | null;
  scriptId: number | string;
  content: string;
}) {
  const scriptId = String(input.scriptId);
  const projectId = input.projectId == null ? null : String(input.projectId);
  const rows = await u
    .db("o_agentWorkData")
    .where("key", "productionAgent")
    .andWhere("episodesId", scriptId)
    .modify((query) => {
      if (projectId != null) query.andWhere("projectId", projectId);
    })
    .select("id", "data");

  let updated = 0;
  for (const row of rows) {
    const data = parseWorkData(row.data);
    if (!data) continue;
    if (data.script === input.content) continue;

    data.script = input.content;
    data.scriptSyncedAt = Date.now();
    await u
      .db("o_agentWorkData")
      .where("id", row.id)
      .update({
        data: JSON.stringify(data),
        updateTime: Date.now(),
      });
    updated++;
  }

  return { matched: rows.length, updated };
}
