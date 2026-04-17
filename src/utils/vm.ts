import { VM } from "vm2";
import sharp from "sharp";
import axios from "axios";
import { createOpenAI } from "@ai-sdk/openai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createZhipu } from "zhipu-ai-provider";
import { createQwen } from "qwen-ai-provider-v5";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createMinimax } from "vercel-minimax-ai-provider";
import FormData from "form-data";
import jsonwebtoken from "jsonwebtoken";
import u from "@/utils";

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

export default function runCode(code: string, vendor?: Record<string, any>) {
  code = code.replace(/export\s*\{\s*\};?/g, ""); // 去掉 export {} 以免沙盒环境报错
  // 创建一个沙盒
  const exports = {};
  const sandbox: Record<string, any> = {
    createOpenAI,
    createDeepSeek,
    createZhipu,
    createQwen,
    createAnthropic,
    createOpenAICompatible,
    createXai,
    createMinimax,
    createGoogleGenerativeAI,
    zipImage,
    zipImageResolution,
    urlToBase64,
    mergeImages,
    pollTask,
    fetch: fetch,
    exports,
    axios,
    FormData,
    logger,
    setTimeout,
    clearTimeout,
    jsonwebtoken,
    jwt: jsonwebtoken,
    JWT: jsonwebtoken,
  };
  if (vendor !== undefined) {
    sandbox.vendor = vendor;
  }
  const vm = new VM({
    timeout: 0,
    sandbox,
    compiler: "javascript",
    eval: false,
    wasm: false,
  });

  vm.run(code);

  return exports as Record<string, any>;
}
export function logger(logstring: string) {
  console.log("【VM】" + logstring);
}

function normalizePollErrorMessage(error: unknown) {
  return u.error(error).message || "poll error";
}

function isRetryablePollError(error: unknown) {
  const message = normalizePollErrorMessage(error).toLowerCase();
  return [
    "fetch failed",
    "network error",
    "network request failed",
    "socket hang up",
    "econnreset",
    "etimedout",
    "eai_again",
    "enotfound",
    "temporarily unavailable",
    "status code 408",
    "status code 409",
    "status code 425",
    "status code 429",
    "status code 500",
    "status code 502",
    "status code 503",
    "status code 504",
  ].some((keyword) => message.includes(keyword));
}
/**
 * 压缩图片，目标字节数不高于 size
 */
export async function zipImage(completeBase64: string, size: number): Promise<string> {
  let quality = 80;
  let buffer = Buffer.from(completeBase64.split(",")[1], "base64");
  let output = await sharp(buffer).jpeg({ quality }).toBuffer();
  while (output.length > size && quality > 10) {
    quality -= 10;
    output = await sharp(buffer).jpeg({ quality }).toBuffer();
  }
  return "data:image/jpeg;base64," + output.toString("base64");
}

export async function zipImageResolution(completeBase64: string, width: number, height: number): Promise<string> {
  const buffer = Buffer.from(completeBase64.split(",")[1], "base64");
  const out = await sharp(buffer).resize(width, height).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

export function getReferenceImageBudget(referenceCount: number): number {
  if (referenceCount <= 0) return MAX_SINGLE_REFERENCE_BYTES;

  return Math.max(
    MIN_SINGLE_REFERENCE_BYTES,
    Math.min(MAX_SINGLE_REFERENCE_BYTES, Math.floor(MAX_TOTAL_REFERENCE_BYTES / referenceCount)),
  );
}

async function optimizeReferenceImage(buffer: Buffer, targetBytes: number): Promise<string> {
  let finalBuffer: Buffer | null = null;

  for (const preset of REFERENCE_PRESETS) {
    const currentBuffer = await sharp(buffer)
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

    finalBuffer = currentBuffer;
    if (currentBuffer.length <= targetBytes) {
      break;
    }
  }

  return `data:image/jpeg;base64,${(finalBuffer || buffer).toString("base64")}`;
}

async function getUrlBuffer(url: string): Promise<Buffer> {
  const localOssPath = u.oss.getLocalPathFromPublicUrl(url);
  if (localOssPath) {
    return await u.oss.getFile(localOssPath);
  }

  const targetUrl = u.oss.resolveFetchUrl(url);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await axios.get(targetUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) {
        const body = Buffer.from(res.data).toString("utf8").slice(0, 500);
        throw new Error(`下载资源失败，状态码: ${res.status}, URL: ${targetUrl}, 响应: ${body}`);
      }
      return Buffer.from(res.data);
    } catch (error) {
      lastError = new Error(`${normalizePollErrorMessage(error)}, URL: ${targetUrl}`);
      if (attempt === 6) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError || new Error("getUrlBuffer failed");
}

export async function compressReferenceBase64(completeBase64: string, targetBytes = getReferenceImageBudget(1)): Promise<string> {
  const base64Body = completeBase64.includes(",") ? completeBase64.split(",")[1] : completeBase64;
  const buffer = Buffer.from(base64Body, "base64");
  return optimizeReferenceImage(buffer, targetBytes);
}

export async function urlToCompressedBase64(url: string, targetBytes = getReferenceImageBudget(1)): Promise<string> {
  const buffer = await getUrlBuffer(url);
  return optimizeReferenceImage(buffer, targetBytes);
}

//url转Base64
export async function urlToBase64(url: string): Promise<string> {
  const localOssPath = u.oss.getLocalPathFromPublicUrl(url);
  if (localOssPath) {
    return await u.oss.getImageBase64(localOssPath);
  }

  const targetUrl = u.oss.resolveFetchUrl(url);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await axios.get(targetUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) {
        const body = Buffer.from(res.data).toString("utf8").slice(0, 500);
        throw new Error(`下载资源失败，状态码: ${res.status}, URL: ${targetUrl}, 响应: ${body}`);
      }
      const mime = res.headers["content-type"] || "image/jpeg";
      const b64 = Buffer.from(res.data).toString("base64");
      return `data:${mime};base64,${b64}`;
    } catch (error) {
      lastError = new Error(`${normalizePollErrorMessage(error)}, URL: ${targetUrl}`);
      if (attempt === 6) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError || new Error("urlToBase64 failed");
}

export async function pollTask(
  fn: () => Promise<{ completed: boolean; data?: string; error?: string }>,
  interval = 3000,
  timeout = 3000000,
): Promise<{ completed: boolean; data?: string; error?: string }> {
  const start = Date.now();
  let lastRetryableError = "";
  while (Date.now() - start < timeout) {
    try {
      const result = await fn();
      if (result.completed) return result;
      if (result?.error) return result;
    } catch (e: any) {
      const message = normalizePollErrorMessage(e);
      if (!isRetryablePollError(e)) {
        return { completed: false, error: message };
      }
      lastRetryableError = message;
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  return { completed: false, error: lastRetryableError ? `timeout: ${lastRetryableError}` : "timeout" };
}

/**
 * 将多张图片横向拼接为一张，并确保输出大小不超过指定限制
 * @param imageBase64List - base64编码的图片数组
 * @param maxSize - 最大输出大小，支持格式如 "10mb", "5MB", "1024kb" 等
 * @returns 拼接后的图片base64字符串
 */
export async function mergeImages(imageBase64List: string[], maxSize = "10mb"): Promise<string> {
  if (imageBase64List.length === 0) {
    throw new Error("图片列表不能为空");
  }

  const maxBytes = parseSize(maxSize);
  const imageBuffers = imageBase64List.map(base64ToBuffer);
  const imageMetadatas = await Promise.all(imageBuffers.map((buffer) => sharp(buffer).metadata()));
  const maxHeight = Math.max(...imageMetadatas.map((m) => m.height || 0));

  // 计算各图片调整后的宽度
  const imageWidths = imageMetadatas.map((metadata) => {
    const aspectRatio = (metadata.width || 1) / (metadata.height || 1);
    return Math.round(maxHeight * aspectRatio);
  });
  const totalWidth = imageWidths.reduce((sum, w) => sum + w, 0);

  // 拼接图片
  const resizedImages = await Promise.all(
    imageBuffers.map(async (buffer, index) => {
      return sharp(buffer).resize(imageWidths[index], maxHeight, { fit: "cover" }).toBuffer();
    }),
  );

  let currentX = 0;
  const compositeInputs = resizedImages.map((buffer, index) => {
    const input = { input: buffer, left: currentX, top: 0 };
    currentX += imageWidths[index];
    return input;
  });

  const mergedBuffer = await sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(compositeInputs)
    .jpeg({ quality: 90 })
    .toBuffer();

  // 复用压缩逻辑
  const resultBuffer = await compressToSize(mergedBuffer, maxBytes, totalWidth, maxHeight);
  return resultBuffer.toString("base64");
}

/**
 * 解析大小字符串为字节数
 */
function parseSize(size: string): number {
  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/);
  if (!match) {
    throw new Error(`无效的大小格式: ${size}`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2] || "b";
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  return Math.floor(value * multipliers[unit]);
}

/**
 * 将base64字符串转换为Buffer
 */
function base64ToBuffer(base64: string): Buffer {
  const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(base64Data, "base64");
}

/**
 * 压缩Buffer到指定大小以内
 */
async function compressToSize(imageBuffer: Buffer, maxBytes: number, originalWidth: number, originalHeight: number): Promise<Buffer> {
  let quality = 90;
  let scale = 1;

  while (true) {
    const targetWidth = Math.round(originalWidth * scale);
    const targetHeight = Math.round(originalHeight * scale);

    const resultBuffer = await sharp(imageBuffer).resize(targetWidth, targetHeight, { fit: "fill" }).jpeg({ quality }).toBuffer();

    if (resultBuffer.length <= maxBytes) {
      return resultBuffer;
    }

    if (quality > 10) {
      quality -= 10;
    } else {
      quality = 90;
      scale *= 0.8;
    }
  }
}
