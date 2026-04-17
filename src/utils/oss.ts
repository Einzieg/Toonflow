import isPathInside from "is-path-inside";
import getPath, { isEletron } from "@/utils/getPath";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(__filename);

type OssProvider = "local" | "tencent-cos";

type CosClient = {
  putObject(options: Record<string, any>, callback: (err: any, data: any) => void): void;
  deleteObject(options: Record<string, any>, callback: (err: any, data: any) => void): void;
};

type CosUploadConfig = {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  pathPrefix: string;
  publicBaseUrl: string;
  objectAcl: string;
};

function normalizeBaseUrl(value?: string | null): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  const trimmedPath = userPath.replace(/^[/\\]+/, "");
  return trimmedPath.split("/").join(path.sep);
}

function normalizePosixPath(userPath: string): string {
  return userPath.replace(/^[/\\]+/, "").split(path.sep).join("/").replace(/\/{2,}/g, "/");
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${pathname.replace(/^\/+/, "")}`;
}

function isProcessableImagePath(value: string): boolean {
  const normalizedValue = String(value || "").split("?")[0].split("#")[0].toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"].some((ext) => normalizedValue.endsWith(ext));
}

// 校验路径
function resolveSafeLocalPath(userPath: string, rootDir: string): string {
  const safePath = normalizeUserPath(userPath);
  const absPath = path.join(rootDir, safePath);
  if (!isPathInside(absPath, rootDir)) {
    throw new Error(`${userPath} 不在 OSS 根目录内`);
  }
  return absPath;
}

class OSS {
  private rootDir: string;
  private initPromise: Promise<void>;
  private cosClientPromise?: Promise<CosClient | null>;
  private warningCache = new Set<string>();

  constructor() {
    this.rootDir = getPath("oss");
    this.initPromise = fs.mkdir(this.rootDir, { recursive: true }).then(() => {});
  }

  private warnOnce(message: string) {
    if (this.warningCache.has(message)) return;
    this.warningCache.add(message);
    console.warn(`[OSS] ${message}`);
  }

  /**
   * 等待根目录初始化完成。用于保证所有文件操作在目录已创建后执行。
   * @private
   */
  private async ensureInit() {
    await this.initPromise;
  }

  private buildPublicPath(userRelPath: string, prefix: string): string {
    const safePath = normalizeUserPath(userRelPath);
    return `/${prefix}/${safePath.split(path.sep).join("/")}`;
  }

  private normalizeStoredRelativePath(userRelPath: string, prefix?: string): string {
    const normalizedPath = normalizePosixPath(userRelPath);
    if (this.getProvider() !== "tencent-cos") return normalizedPath;
    if (prefix && prefix !== "oss") return normalizedPath;

    const pathPrefix = this.getCosPathPrefix();
    if (!pathPrefix) return normalizedPath;

    let nextPath = normalizedPath;
    while (nextPath === pathPrefix || nextPath.startsWith(`${pathPrefix}/`)) {
      nextPath = nextPath === pathPrefix ? "" : nextPath.slice(pathPrefix.length + 1);
    }
    return nextPath;
  }

  private resolvePathInput(
    userRelPath: string,
    prefix?: string,
  ): {
    relativePath: string;
    passthroughUrl: string | null;
  } {
    const rawPath = String(userRelPath || "").trim();
    if (!rawPath) {
      return { relativePath: "", passthroughUrl: null };
    }

    const localPath = this.getLocalPathFromPublicUrl(rawPath);
    if (localPath !== null) {
      return {
        relativePath: this.normalizeStoredRelativePath(localPath, prefix),
        passthroughUrl: null,
      };
    }

    if (/^https?:\/\//i.test(rawPath)) {
      return { relativePath: "", passthroughUrl: rawPath };
    }

    return {
      relativePath: this.normalizeStoredRelativePath(rawPath, prefix),
      passthroughUrl: null,
    };
  }

  private getProvider(): OssProvider {
    return process.env.OSS_PROVIDER === "tencent-cos" ? "tencent-cos" : "local";
  }

  private getStaticBaseUrl(): string {
    return normalizeBaseUrl(process.env.OSS_PUBLIC_BASE_URL || process.env.OSSURL);
  }

  private getCosPublicBaseUrl(): string {
    return normalizeBaseUrl(process.env.OSS_COS_PUBLIC_BASE_URL);
  }

  private getCosPathPrefix(): string {
    return normalizePosixPath(process.env.OSS_COS_PATH_PREFIX || "");
  }

  private getCosUploadConfig(): CosUploadConfig | null {
    if (this.getProvider() !== "tencent-cos") {
      return null;
    }

    const bucket = String(process.env.OSS_COS_BUCKET || "").trim();
    const region = String(process.env.OSS_COS_REGION || "").trim();
    const secretId = String(process.env.OSS_COS_SECRET_ID || "").trim();
    const secretKey = String(process.env.OSS_COS_SECRET_KEY || "").trim();

    if (!bucket || !region || !secretId || !secretKey) {
      this.warnOnce("检测到 OSS_PROVIDER=tencent-cos，但 OSS_COS_BUCKET / OSS_COS_REGION / OSS_COS_SECRET_ID / OSS_COS_SECRET_KEY 未完整配置，已回退到本地 OSS。");
      return null;
    }

    return {
      bucket,
      region,
      secretId,
      secretKey,
      pathPrefix: this.getCosPathPrefix(),
      publicBaseUrl: this.getCosPublicBaseUrl(),
      objectAcl: String(process.env.OSS_COS_OBJECT_ACL || "").trim(),
    };
  }

  private async getCosClient(): Promise<CosClient | null> {
    const config = this.getCosUploadConfig();
    if (!config) return null;

    if (!this.cosClientPromise) {
      this.cosClientPromise = Promise.resolve()
        .then(() => {
          try {
            const COS = nodeRequire("cos-nodejs-sdk-v5");
            const CosCtor = COS?.default || COS;
            return new CosCtor({
              SecretId: config.secretId,
              SecretKey: config.secretKey,
            }) as CosClient;
          } catch (error) {
            this.warnOnce("未安装 cos-nodejs-sdk-v5，已回退到本地 OSS。请重新安装依赖后再启用腾讯云 COS。");
            return null;
          }
        })
        .catch(() => null);
    }

    return this.cosClientPromise;
  }

  private buildCosObjectKey(userRelPath: string): string {
    const normalizedPath = this.normalizeStoredRelativePath(userRelPath, "oss");
    const pathPrefix = this.getCosPathPrefix();
    return pathPrefix ? `${pathPrefix}/${normalizedPath}` : normalizedPath;
  }

  private stripCosObjectKeyPrefix(objectKey: string): string | null {
    const normalizedKey = normalizePosixPath(objectKey);
    const pathPrefix = this.getCosPathPrefix();
    if (!pathPrefix) return normalizedKey;

    let strippedKey = normalizedKey;
    let matched = false;
    while (strippedKey === pathPrefix || strippedKey.startsWith(`${pathPrefix}/`)) {
      matched = true;
      strippedKey = strippedKey === pathPrefix ? "" : strippedKey.slice(pathPrefix.length + 1);
    }

    if (!matched) return null;
    return strippedKey;
  }

  private guessMimeType(userRelPath: string): string | undefined {
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".webm": "video/webm",
    };
    return mimeTypes[ext];
  }

  private async uploadRemoteFile(userRelPath: string, buffer: Buffer): Promise<void> {
    const cosClient = await this.getCosClient();
    const config = this.getCosUploadConfig();
    if (!cosClient || !config) return;

    const params: Record<string, any> = {
      Bucket: config.bucket,
      Region: config.region,
      Key: this.buildCosObjectKey(userRelPath),
      Body: buffer,
      ContentLength: buffer.length,
    };

    const contentType = this.guessMimeType(userRelPath);
    if (contentType) {
      params.ContentType = contentType;
    }
    if (config.objectAcl) {
      params.ACL = config.objectAcl;
    }

    await new Promise<void>((resolve, reject) => {
      cosClient.putObject(params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async deleteRemoteFile(userRelPath: string): Promise<void> {
    const cosClient = await this.getCosClient();
    const config = this.getCosUploadConfig();
    if (!cosClient || !config) return;

    await new Promise<void>((resolve, reject) => {
      cosClient.deleteObject(
        {
          Bucket: config.bucket,
          Region: config.region,
          Key: this.buildCosObjectKey(userRelPath),
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  private async collectDirectoryFiles(absPath: string, relativeRoot: string): Promise<string[]> {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const absChildPath = path.join(absPath, entry.name);
      const relChildPath = normalizePosixPath(path.join(relativeRoot, entry.name));
      if (entry.isDirectory()) {
        files.push(...(await this.collectDirectoryFiles(absChildPath, relChildPath)));
      } else if (entry.isFile()) {
        files.push(relChildPath);
      }
    }

    return files;
  }

  private async getRemoteFileUrl(userRelPath: string, prefix: string): Promise<string | null> {
    if (prefix !== "oss") return null;
    const cosClient = await this.getCosClient();
    const publicBaseUrl = this.getCosPublicBaseUrl();
    if (!cosClient || !publicBaseUrl) return null;
    return joinUrl(publicBaseUrl, this.buildCosObjectKey(userRelPath));
  }

  getInternalBaseUrl(): string {
    const runtimePort = process.env.PORT || "10588";
    return isEletron() ? `http://localhost:${runtimePort}` : `http://127.0.0.1:${runtimePort}`;
  }

  resolveFetchUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const normalizedPath = url.startsWith("/") ? url : `/${url}`;
    return `${this.getInternalBaseUrl()}${normalizedPath}`;
  }

  buildImagePreviewUrl(publicUrl: string, options?: { width?: number; height?: number; format?: "webp" | "jpeg" | "png" }): string {
    if (!publicUrl || this.getProvider() !== "tencent-cos" || !isProcessableImagePath(publicUrl)) {
      return publicUrl;
    }

    const cosBaseUrl = this.getCosPublicBaseUrl();
    if (!cosBaseUrl || !publicUrl.startsWith(`${cosBaseUrl}/`)) {
      return publicUrl;
    }

    const width = Math.max(0, Math.round(Number(options?.width || 0)));
    const height = Math.max(0, Math.round(Number(options?.height || 0)));
    const format = options?.format || "webp";
    const processSegments = ["imageView2", "1"];

    if (width > 0) processSegments.push("w", String(width));
    if (height > 0) processSegments.push("h", String(height));
    if (format) processSegments.push("format", format);

    const separator = publicUrl.includes("?") ? "&" : "?";
    return `${publicUrl}${separator}${processSegments.join("/")}`;
  }

  getLocalPathFromPublicUrl(url: string): string | null {
    const normalizedUrl = url.split("?")[0].split("#")[0];
    const publicPrefix = "/oss/";
    if (normalizedUrl.startsWith(publicPrefix)) {
      return normalizedUrl.slice(publicPrefix.length);
    }

    const internalPrefix = `${this.getInternalBaseUrl()}${publicPrefix}`;
    if (normalizedUrl.startsWith(internalPrefix)) {
      return normalizedUrl.slice(internalPrefix.length);
    }

    const staticBaseUrl = this.getStaticBaseUrl();
    if (staticBaseUrl) {
      const staticPrefix = `${staticBaseUrl}/oss/`;
      if (normalizedUrl.startsWith(staticPrefix)) {
        return normalizedUrl.slice(staticPrefix.length);
      }
    }

    const cosBaseUrl = this.getCosPublicBaseUrl();
    if (cosBaseUrl && normalizedUrl.startsWith(`${cosBaseUrl}/`)) {
      const objectKey = normalizedUrl.slice(cosBaseUrl.length + 1);
      return this.stripCosObjectKeyPrefix(objectKey);
    }

    return null;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件的公开访问地址
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    if (!prefix) prefix = "oss";
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, prefix);
    if (passthroughUrl) {
      return passthroughUrl;
    }

    const remoteUrl = await this.getRemoteFileUrl(normalizedPath, prefix);
    if (remoteUrl) {
      return remoteUrl;
    }

    const staticBaseUrl = this.getStaticBaseUrl();
    if (staticBaseUrl) {
      return joinUrl(staticBaseUrl, this.buildPublicPath(normalizedPath, prefix));
    }

    if (isEletron()) {
      return `${this.getInternalBaseUrl()}${this.buildPublicPath(normalizedPath, prefix)}`;
    }
    return this.buildPublicPath(normalizedPath, prefix);
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    return fs.readFile(resolveSafeLocalPath(normalizedPath, this.rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL
   * @throws 路径不在 OSS 根目录内、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(normalizedPath, this.rootDir);

    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`${userRelPath} 不是文件`);
    }

    const mimeType = this.guessMimeType(normalizedPath);
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${path.extname(normalizedPath).toLowerCase()}`);
    }

    const data = await fs.readFile(absPath);
    const base64 = data.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    await fs.unlink(resolveSafeLocalPath(normalizedPath, this.rootDir));
    await this.deleteRemoteFile(normalizedPath);
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件夹不存在、目标是文件而非文件夹等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(normalizedPath, this.rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }

    const remoteFiles = await this.collectDirectoryFiles(absPath, normalizePosixPath(normalizedPath));
    await fs.rm(absPath, { recursive: true, force: true });

    const results = await Promise.allSettled(remoteFiles.map(async (filePath) => await this.deleteRemoteFile(filePath)));
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      this.warnOnce(`删除 COS 远端文件时出现异常：${String(rejected.reason)}`);
    }
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * 写入前自动创建所需的父文件夹。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param data 要写入的数据，可以为 Buffer 或字符串
   * @throws 路径不在 OSS 根目录内等错误
   */
  async writeFile(userRelPath: string, data: Buffer | string): Promise<void> {
    await this.ensureInit();
    const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(normalizedPath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    await fs.writeFile(absPath, buffer);
    await this.uploadRemoteFile(normalizedPath, buffer);
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    await this.ensureInit();
    try {
      const { relativePath: normalizedPath, passthroughUrl } = this.resolvePathInput(userRelPath, "oss");
      if (passthroughUrl) {
        return false;
      }
      const stat = await fs.stat(resolveSafeLocalPath(normalizedPath, this.rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

export default new OSS();
