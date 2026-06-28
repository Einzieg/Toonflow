import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    describe: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
    resolution: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, describe, projectId, imageId, resolution } = req.body;
    const updateData: Record<string, string | number | null> = {};
    if ("prompt" in req.body) updateData.prompt = prompt ?? "";
    if ("describe" in req.body) updateData.describe = describe ?? "";
    if ("imageId" in req.body) updateData.imageId = imageId ?? null;

    if (base64) {
      //自定义上传选择的图片
      const matches = base64.match(/^data:image\/\w+;base64,(.+)$/);
      const realBase64 = matches ? matches[1] : base64;
      // 生成新的图片路径
      const savePath = `/${projectId}/${type}/${uuidv4()}.png`;
      // 写入文件
      await u.oss.writeFile(savePath, Buffer.from(realBase64, "base64"));
      // 插入图片表
      const [idData] = await u.db("o_image").insert({
        assetsId: id,
        filePath: savePath,
        type: type,
        state: "已完成",
        resolution: resolution ?? null,
      });
      // 更新资产表图片为新图片
      await u
        .db("o_assets")
        .where("id", id)
        .update({
          prompt: prompt ?? "",
          ...(describe !== undefined ? { describe: describe ?? "" } : {}),
          imageId: idData,
        });
    } else if (Object.keys(updateData).length > 0) {
      await u.db("o_assets").where("id", id).update(updateData);
    }
    res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);
