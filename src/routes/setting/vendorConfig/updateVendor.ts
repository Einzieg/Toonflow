import express from "express";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";

const router = express.Router();

function normalizeInputValues(id: string, inputValues: Record<string, string>) {
  const nextValues = Object.fromEntries(Object.entries(inputValues).map(([key, value]) => [key, String(value ?? "").trim()]));
  const baseUrl = nextValues.baseUrl?.replace(/\/+$/, "");
  if (baseUrl) nextValues.baseUrl = baseUrl;

  if (id === "openai" && /^https?:\/\/openrouter\.ai\/v1$/i.test(nextValues.baseUrl || "")) {
    nextValues.baseUrl = "https://openrouter.ai/api/v1";
  }

  if (id === "klingai") {
    const accessKey = nextValues.accessKey || nextValues.apiKey || nextValues.ak || nextValues.access_key || "";
    const secretKey = nextValues.secretKey || nextValues.sk || nextValues.secret_key || nextValues.apiSecret || nextValues.secret || "";
    nextValues.accessKey = accessKey;
    nextValues.secretKey = secretKey;
    if (!nextValues.apiKey) nextValues.apiKey = accessKey;
    if (!nextValues.sk) nextValues.sk = secretKey;
  }

  return nextValues;
}

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    inputValues: z.record(z.string(), z.string()),
  }),
  async (req, res) => {
    const { id, inputValues } = req.body;
    const vendor = await u.db("o_vendorConfig").where("id", id).first("id");

    if (!vendor) {
      return res.status(404).send(error("未找到该供应商配置"));
    }

    await u
      .db("o_vendorConfig")
      .where("id", id)
      .update({
        inputValues: JSON.stringify(normalizeInputValues(id, inputValues)),
      });

    res.status(200).send(success("更新成功"));
  },
);
