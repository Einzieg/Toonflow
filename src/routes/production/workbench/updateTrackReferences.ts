import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

const referenceItemSchema = z.object({
  id: z.number(),
  sources: z.enum(["assets", "storyboard"]),
  referenceImageKind: z.enum(["storyboard", "grid", "tailFrame"]).optional(),
});

function normalizeReferenceImageKind(value: unknown) {
  if (value === "grid" || value === "tailFrame") return value;
  return "storyboard";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
    items: z.array(referenceItemSchema),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackId, items } = req.body as {
      projectId: number;
      scriptId: number;
      trackId: number;
      items: Array<z.infer<typeof referenceItemSchema>>;
    };

    const track = await u.db("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
    if (!track) {
      return res.status(404).send(error("视频轨道不存在"));
    }

    const normalizedItems = items
      .map((item) => ({
        id: Number(item.id),
        sources: item.sources,
        referenceImageKind: item.sources === "storyboard" ? normalizeReferenceImageKind(item.referenceImageKind) : undefined,
      }))
      .filter((item) => Number.isInteger(item.id) && item.id > 0);

    await u.db("o_videoTrack").where({ id: trackId }).update({
      referenceMediaOverride: JSON.stringify(normalizedItems),
    });

    res.status(200).send(success({ fixed: true, count: normalizedItems.length }));
  },
);
