import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    items: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { items } = req.body;
    const result: Record<string, string> = {};

    const storyboardIds = items.filter((item) => item.sources === "storyboard").map((item) => item.id);
    const totalFilePaths: { id: number; filePath: string; sources: string }[] = [];

    if (storyboardIds.length) {
      const storyboardPaths = await u.db("o_storyboard").whereIn("id", storyboardIds).select("id", "filePath");
      totalFilePaths.push(
        ...storyboardPaths.map((item) => ({
          id: item.id,
          filePath: item.filePath,
          sources: "storyboard",
        })),
      );
    }

    const assetsIds = items.filter((item) => item.sources === "assets").map((item) => item.id);
    if (assetsIds.length) {
      const assetsPaths = await u
        .db("o_assets")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .whereIn("o_assets.id", assetsIds)
        .select("o_assets.id", "o_image.filePath");

      totalFilePaths.push(
        ...assetsPaths.map((item) => ({
          id: item.id,
          filePath: item.filePath,
          sources: "assets",
        })),
      );
    }

    await Promise.all(
      totalFilePaths.map(async (item) => {
        result[`${item.id}:${item.sources}`] = item.filePath ? await u.oss.getFileUrl(item.filePath) : "";
      }),
    );

    res.status(200).send(success({ data: result }));
  },
);
