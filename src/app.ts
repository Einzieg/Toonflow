// import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import buildRoute from "@/core";
import path from "path";
import fs from "fs";
import fsp from "node:fs/promises";
import u from "@/utils";
import jwt from "jsonwebtoken";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import sharp from "sharp";
import crypto from "node:crypto";

const app = express();
const server = http.createServer(app);
const OSS_PREVIEW_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OSS_PREVIEW_CONCURRENCY || "4", 10) || 4);
const SHARP_CONCURRENCY = Math.max(1, Number.parseInt(process.env.SHARP_CONCURRENCY || "4", 10) || 4);
let activePreviewTransforms = 0;
const previewTransformQueue: Array<() => void> = [];

sharp.concurrency(SHARP_CONCURRENCY);

async function withPreviewTransformSlot<T>(fn: () => Promise<T>) {
  if (activePreviewTransforms >= OSS_PREVIEW_CONCURRENCY) {
    await new Promise<void>((resolve) => previewTransformQueue.push(resolve));
  }

  activePreviewTransforms += 1;
  try {
    return await fn();
  } finally {
    activePreviewTransforms -= 1;
    previewTransformQueue.shift()?.();
  }
}

function previewContentType(format: string) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function previewCacheExtension(format: string) {
  return format === "jpeg" ? "jpg" : format;
}

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const testFile = path.join(userDataPath, ".access_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请联系管理员授予权限，或以管理员身份运行本程序。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
  }
}

export default async function startServe(randomPort: Boolean = false) {
  await checkPermissions();

  await u.writeVersion();
  const io = new Server(server, { cors: { origin: "*" } });
  socketInit(io);

  if (process.env.NODE_ENV == "dev") await buildRoute();

  expressWs(app);

  app.use(logger("dev"));
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // oss 静态资源
  const ossDir = u.getPath("oss");
  if (!fs.existsSync(ossDir)) {
    fs.mkdirSync(ossDir, { recursive: true });
  }
  console.log("文件目录:", ossDir);
  app.use("/oss", express.static(ossDir, { acceptRanges: false }));
  app.get(/^\/oss-preview\/(.+)$/, async (req, res) => {
    try {
      const encodedPath = String(req.params[0] || "");
      const relativePath = decodeURIComponent(encodedPath);
      if (relativePath.startsWith(".preview-cache/") || relativePath.includes("/.preview-cache/")) {
        return res.status(404).end();
      }
      if (!/\.(jpe?g|png|webp|bmp|gif)$/i.test(relativePath)) {
        return res.status(404).end();
      }

      const absolutePath = u.oss.resolveLocalAbsolutePath(relativePath);
      if (!fs.existsSync(absolutePath)) {
        return res.status(404).end();
      }

      const width = Math.min(4096, Math.max(0, Number.parseInt(String(req.query.w || ""), 10) || 0));
      const height = Math.min(4096, Math.max(0, Number.parseInt(String(req.query.h || ""), 10) || 0));
      const format = ["webp", "jpeg", "png"].includes(String(req.query.format || "")) ? String(req.query.format) : "webp";
      const stat = await fsp.stat(absolutePath);
      const cacheKey = crypto
        .createHash("sha1")
        .update(JSON.stringify({ relativePath, size: stat.size, mtimeMs: stat.mtimeMs, width, height, format }))
        .digest("hex");
      const cacheDir = path.join(ossDir, ".preview-cache", cacheKey.slice(0, 2));
      const cachePath = path.join(cacheDir, `${cacheKey}.${previewCacheExtension(format)}`);
      const sendCachedPreview = () => {
        res.type(previewContentType(format));
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
        return res.sendFile(cachePath, { dotfiles: "allow" });
      };

      if (fs.existsSync(cachePath)) {
        return sendCachedPreview();
      }

      await withPreviewTransformSlot(async () => {
        if (fs.existsSync(cachePath)) return;
        await fsp.mkdir(cacheDir, { recursive: true });

        const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        const transformer = sharp(absolutePath, { failOn: "none" }).rotate();

        if (width > 0 || height > 0) {
          transformer.resize({
            width: width || undefined,
            height: height || undefined,
            fit: "inside",
            withoutEnlargement: true,
          });
        }

        if (format === "jpeg") {
          transformer.jpeg({ quality: 82, mozjpeg: true });
        } else if (format === "png") {
          transformer.png({ compressionLevel: 9 });
        } else {
          transformer.webp({ quality: 82, effort: 4 });
        }

        await transformer.toFile(tmpPath);
        await fsp.rename(tmpPath, cachePath);
      });

      return sendCachedPreview();
    } catch (error: any) {
      if (error?.message?.includes("不在 OSS 根目录内")) {
        return res.status(403).end();
      }
      console.error("[oss-preview]", error);
      return res.status(500).end();
    }
  });
  // skills 静态资源
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  console.log("文件目录:", skillsDir);
  // 只允许图片文件访问
  app.use(
    "/skills",
    (req, res, next) => {
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, { acceptRanges: false }),
  );

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  console.log("文件目录:", assetsDir);
  app.use("/assets", express.static(assetsDir, { acceptRanges: false }));

  // data/web 静态网站
  const webDir = u.getPath("web");
  if (fs.existsSync(webDir)) {
    console.log("静态网站目录:", webDir);
    app.use("/web", express.static(webDir, { acceptRanges: false }));
    app.use(express.static(webDir, { acceptRanges: false }));
  } else {
    console.warn("静态网站目录不存在:", webDir);
  }

  app.use(async (req, res, next) => {
    const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
    if (!setting) return res.status(444).send({ message: "服务器秘钥未配置，请联系管理员" });
    const { value: tokenKey } = setting;
    // 从 header 或 query 参数获取 token
    const rawToken = req.headers.authorization || (req.query.token as string) || "";
    const token = rawToken.replace("Bearer ", "");
    // 白名单路径
    if (req.path === "/api/login/login" || req.path === "/login/login") return next();

    if (!token) return res.status(401).send({ message: "未提供token" });
    try {
      const decoded = jwt.verify(token, tokenKey as string);
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).send({ message: "无效的token" });
    }
  });

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    console.error(err);
    res.status(err.status || 500).send(err);
  });

  const configuredPort = Number.parseInt(process.env.PORT || "", 10);
  const port = randomPort ? 0 : Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 10588;
  return await new Promise((resolve) => {
    server.listen(port, async () => {
      const address = server.address();
      const realPort = typeof address === "string" ? address : address?.port;
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      resolve(realPort);
    });
  });
}

// 支持await关闭
export function closeServe(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        console.log("[服务已关闭]");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();
