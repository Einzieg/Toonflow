import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { syncProductionScriptToWorkData } from "@/utils/productionWorkDataSync";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    content: z.string(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    const script = await u.db("o_script").where({ id }).select("projectId").first();
    await u.db("o_script").where({ id }).update({
      name,
      content,
    });
    await syncProductionScriptToWorkData({ projectId: script?.projectId ?? null, scriptId: id, content });
    if (assets.length) {
      const assetsData = await u.db("o_assets").whereIn("id", assets).select();
      await u.db("o_scriptAssets").where({ scriptId: id }).delete();
      if (assetsData.length) {
        const insertData = assetsData.map((item) => {
          return {
            scriptId: id,
            assetId: item.id,
          };
        });
        await u.db("o_scriptAssets").insert(insertData);
      }
    }

    res.status(200).send(success({ message: "编辑剧本成功" }));
  },
);
