import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const assetsData = await u.db("o_image").where({ id }).select("filePath");
    await Promise.all(
      assetsData.map((i) =>
        i.filePath
          ? u.oss.deleteFile(i.filePath).catch((e) => {
              if (e?.code !== "ENOENT") throw e;
            })
          : Promise.resolve(),
      ),
    );
    await u.db("o_assets").where({ imageId: id }).update({
      imageId: null,
    });
    await u.db("o_image").where({ id }).delete();
    res.status(200).send(success({ message: "资产图片删除成功" }));
  },
);
