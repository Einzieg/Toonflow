import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import axios from "axios";
import sharp from "sharp";
const router = express.Router();

const MAX_TOTAL_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_REFERENCE_BYTES = 1800 * 1024;
const MIN_SINGLE_REFERENCE_BYTES = 400 * 1024;
const REFERENCE_PRESETS = [
  { maxEdge: 1600, quality: 82 },
  { maxEdge: 1440, quality: 78 },
  { maxEdge: 1280, quality: 74 },
  { maxEdge: 1024, quality: 70 },
  { maxEdge: 896, quality: 66 },
  { maxEdge: 768, quality: 62 },
];

function getReferenceBudget(referenceCount: number) {
  if (referenceCount <= 0) return MAX_SINGLE_REFERENCE_BYTES;

  return Math.max(
    MIN_SINGLE_REFERENCE_BYTES,
    Math.min(MAX_SINGLE_REFERENCE_BYTES, Math.floor(MAX_TOTAL_REFERENCE_BYTES / referenceCount)),
  );
}

async function getImageBuffer(imageUrl: string): Promise<Buffer> {
  const localOssPath = u.oss.getLocalPathFromPublicUrl(imageUrl);
  if (localOssPath) {
    return await u.oss.getFile(localOssPath);
  }

  const response = await axios.get(u.oss.resolveFetchUrl(imageUrl), {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return Buffer.from(response.data);
}

async function urlToCompressedBase64(imageUrl: string, targetBytes: number): Promise<string> {
  const originalBuffer = await getImageBuffer(imageUrl);
  let finalBuffer: Buffer | null = null;

  for (const preset of REFERENCE_PRESETS) {
    const buffer = await sharp(originalBuffer)
      .rotate()
      .resize({
        width: preset.maxEdge,
        height: preset.maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: preset.quality, mozjpeg: true })
      .toBuffer();

    finalBuffer = buffer;
    if (buffer.length <= targetBytes) {
      break;
    }
  }

  return `data:image/jpeg;base64,${(finalBuffer || originalBuffer).toString("base64")}`;
}
export default router.post(
  "/",
  validateFields({
    model: z.string(),
    references: z.array(z.string()).optional(),
    quality: z.string(),
    ratio: z.string(),
    prompt: z.string(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { model, references = [], quality, ratio, prompt, projectId } = req.body;
    const referenceBudget = getReferenceBudget(references.length);

    const imageClass = await u.Ai.Image(model).run(
      {
        prompt: prompt,
        referenceList: await (async () => {
          const list: { type: "image"; base64: string }[] = [];
          for (const url of references) {
            list.push({ type: "image" as const, base64: await urlToCompressedBase64(url, referenceBudget) });
          }
          return list;
        })(),
        size: quality,
        aspectRatio: ratio,
      },
      {
        taskClass: "工作流图片生成",
        describe: "工作流图片生成",
        relatedObjects: JSON.stringify(req.body),
        projectId: projectId,
      },
    );
    const savePath = `${projectId}/workFlow/${u.uuid()}.jpg`;
    await imageClass.save(savePath);

    const url = await u.oss.getFileUrl(savePath);
    return res.status(200).send(success({ url }));
  },
);
