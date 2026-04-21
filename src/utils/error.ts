// utils/error.ts
import { serializeError } from "serialize-error";
import { isAxiosError } from "axios";

export interface NormalizedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
  cause?: NormalizedError;
  responseData?: unknown;
  meta?: Record<string, unknown>;
}

export function normalizeError(error: unknown): NormalizedError {
  // Axios 特殊处理
  if (isAxiosError(error)) {
    return {
      name: "AxiosError",
      message: error.response?.data?.error?.message || error.response?.data?.message || error.message,
      code: error.code,
      status: error.response?.status,
      stack: error.stack,
      responseData: error.response?.data,
      meta: {
        url: error.config?.url,
        method: error.config?.method,
      },
    };
  }

  // 普通 Error，用 serialize-error 处理
  if (error instanceof Error) {
    const serialized = serializeError(error);
    return {
      name: serialized.name || "Error",
      message: serialized.message || "未知错误",
      code: (serialized as any).code,
      stack: serialized.stack,
      cause: error.cause ? normalizeError(error.cause) : undefined,
      meta: extractMeta(serialized),
    };
  }

  // OpenAI-compatible providers sometimes throw plain objects.
  if (typeof error === "object" && error !== null) {
    const serialized = serializeError(error) as Record<string, any>;
    const message =
      typeof serialized.message === "string" && serialized.message
        ? serialized.message
        : typeof (error as any).message === "string" && (error as any).message
          ? (error as any).message
          : JSON.stringify(serialized);

    return {
      name: serialized.name || "UnknownError",
      message: message || "未知错误",
      code: serialized.code,
      status: serialized.status,
      stack: serialized.stack,
      responseData: serialized.responseData,
      meta: extractMeta(serialized),
    };
  }

  // 非 Error
  return {
    name: "UnknownError",
    message: String(error),
    meta: { raw: serializeError(error) },
  };
}

// 提取自定义属性
function extractMeta(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const standardKeys = ["name", "message", "stack", "cause"];
  const meta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (!standardKeys.includes(key) && value !== undefined) {
      meta[key] = value;
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export default normalizeError;
