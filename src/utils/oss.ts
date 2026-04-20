import isPathInside from "is-path-inside";
import getPath, { isEletron } from "@/utils/getPath";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

function normalizeBaseUrl(value?: string | null): string {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  // 去除前导的 / 或 \
  const trimmedPath = userPath.replace(/^[/\\]+/, "");
  // 将所有 / 替换为系统路径分隔符（path.sep）
  // 这样在 Windows 上会转为 \，在 Unix 上保持 /
  return trimmedPath.split("/").join(path.sep);
}

function normalizePosixPath(userPath: string): string {
  return String(userPath || "")
    .replace(/^[/\\]+/, "")
    .split(path.sep)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function joinUrl(baseUrl: string, pathname: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${pathname.replace(/^\/+/, "")}`;
}

function encodeUrlPath(userPath: string): string {
  return normalizePosixPath(userPath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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

  constructor() {
    this.rootDir = getPath("oss");
    // 初始化时自动创建根目录
    this.initPromise = fs.mkdir(this.rootDir, { recursive: true }).then(() => {});
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

  private resolvePathInput(
    userRelPath: string,
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
      return { relativePath: normalizePosixPath(localPath), passthroughUrl: null };
    }

    if (/^https?:\/\//i.test(rawPath)) {
      return { relativePath: "", passthroughUrl: rawPath };
    }

    return { relativePath: normalizePosixPath(rawPath), passthroughUrl: null };
  }

  private getStaticBaseUrl(): string {
    return normalizeBaseUrl(process.env.OSS_PUBLIC_BASE_URL || process.env.OSSURL || process.env.ossURL);
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
    if (!publicUrl || !isProcessableImagePath(publicUrl) || publicUrl.includes("/oss-preview/")) {
      return publicUrl;
    }

    const localPath = this.getLocalPathFromPublicUrl(publicUrl);
    if (!localPath) {
      return publicUrl;
    }

    const width = Math.max(0, Math.round(Number(options?.width || 0)));
    const height = Math.max(0, Math.round(Number(options?.height || 0)));
    const format = options?.format || "webp";
    const searchParams = new URLSearchParams();
    if (width > 0) searchParams.set("w", String(width));
    if (height > 0) searchParams.set("h", String(height));
    if (format) searchParams.set("format", format);

    const previewPath = `/oss-preview/${encodeUrlPath(localPath)}`;
    const previewUrl = searchParams.size ? `${previewPath}?${searchParams.toString()}` : previewPath;
    const staticBaseUrl = this.getStaticBaseUrl();
    if (staticBaseUrl) {
      return joinUrl(staticBaseUrl, previewUrl);
    }
    if (isEletron()) {
      return `${this.getInternalBaseUrl()}${previewUrl}`;
    }
    return previewUrl;
  }

  resolveLocalAbsolutePath(userRelPath: string): string {
    return resolveSafeLocalPath(userRelPath, this.rootDir);
  }

  getLocalPathFromPublicUrl(url: string): string | null {
    const normalizedUrl = String(url || "").split("?")[0].split("#")[0];
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

    return null;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件的 http 链接（本地服务地址）
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    if (!prefix) prefix = "oss";
    await this.ensureInit();
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      return passthroughUrl;
    }

    const publicPath = this.buildPublicPath(relativePath, prefix);
    const staticBaseUrl = this.getStaticBaseUrl();
    if (staticBaseUrl) {
      return joinUrl(staticBaseUrl, publicPath);
    }
    if (process.env.NODE_ENV == "dev") return `http://localhost:10588${publicPath}`;
    if (isEletron()) return `${this.getInternalBaseUrl()}${publicPath}`;
    return publicPath;
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    await this.ensureInit();
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    return fs.readFile(resolveSafeLocalPath(relativePath, this.rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL (例如: data:image/png;base64,iVBORw0KGgo...)
   * @throws 路径不在 OSS 根目录内、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    await this.ensureInit();
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(relativePath, this.rootDir);

    // 检查文件是否存在且为文件
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`${userRelPath} 不是文件`);
    }

    // 获取文件扩展名并确定 MIME 类型
    const ext = path.extname(relativePath).toLowerCase();
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
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}`);
    }

    // 读取文件并转换为 base64
    const data = await fs.readFile(absPath);
    const base64 = data.toString("base64");

    // 返回完整的 Data URL
    return `data:${mimeType};base64,${base64}`;
  }
  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    await fs.unlink(resolveSafeLocalPath(relativePath, this.rootDir));
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件夹不存在、目标是文件而非文件夹等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(relativePath, this.rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }
    await fs.rm(absPath, { recursive: true, force: true });
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
    const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
    if (passthroughUrl) {
      throw new Error(`${userRelPath} 不是受支持的 OSS 路径`);
    }
    const absPath = resolveSafeLocalPath(relativePath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // 如果 data 是 string，则视为 base64 编码，先解码再写入
    // 自动去除可能存在的 Data URL 前缀（如 "data:image/png;base64,"）
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    await fs.writeFile(absPath, buffer);
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    await this.ensureInit();
    try {
      const { relativePath, passthroughUrl } = this.resolvePathInput(userRelPath);
      if (passthroughUrl) {
        return false;
      }
      const stat = await fs.stat(resolveSafeLocalPath(relativePath, this.rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 获取图片的缩略图 URL（最长边不超过 512px，等比缩放）。
   * 缩略图保存在原路径同目录下的 smallImage 子文件夹中。
   * 若缩略图已存在则直接返回其 URL；若不存在则同步生成并保存后返回缩略图 URL，
   * 生成失败时返回原图 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 缩略图 URL（已存在或生成成功）或原图 URL（生成失败时）
   */
  async getSmallImageUrl(userRelPath: string): Promise<string> {
    // 构造缩略图相对路径：在原路径的目录层级前插入 smallImage 目录
    // 例如：123/abc.jpg => smallImage/123/abc.jpg
    const smallImageRelPath = `smallImage/${userRelPath.replace(/^[/\\]+/, "")}`;

    if (await this.fileExists(smallImageRelPath)) {
      return this.getFileUrl(smallImageRelPath);
    }

    // 缩略图不存在：同步生成，生成失败则返回原图 URL
    const originalUrl = await this.getFileUrl(userRelPath);

    try {
      await this.ensureInit();
      const srcAbsPath = resolveSafeLocalPath(userRelPath, this.rootDir);
      const dstAbsPath = resolveSafeLocalPath(smallImageRelPath, this.rootDir);
      await fs.mkdir(path.dirname(dstAbsPath), { recursive: true });
      await sharp(srcAbsPath)
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .toFile(dstAbsPath);
      console.info(`[${dstAbsPath}]小图写入成功`);
      return this.getFileUrl(smallImageRelPath);
    } catch (e) {
      // 生成失败返回原图
      console.warn("[OSS] 生成缩略图失败:", e);
      return originalUrl;
    }
  }
}

export default new OSS();
