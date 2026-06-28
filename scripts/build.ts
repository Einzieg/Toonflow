import esbuild from "esbuild";
import fs from "fs";
import path from "path";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const external = [
  "electron",
  "@huggingface/transformers",
  "onnxruntime-node",
  "vm2",
  "sqlite3",
  "better-sqlite3",
  "sharp",
  "ffmpeg-static",
  "mysql",
  "mysql2",
  "pg",
  "pg-query-stream",
  "oracledb",
  "tedious",
  "mssql",
];

// 后端服务打包配置
const appBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: `data/serve/app.js`,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

// Electron 主进程打包配置
const mainBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["scripts/main.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  outfile: `build/main.js`,
  allowOverwrite: true,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

function copyFfmpegBinary() {
  let ffmpegPath = "";
  try {
    ffmpegPath = require("ffmpeg-static");
  } catch (error) {
    console.warn("⚠️ 未找到 ffmpeg-static，视频尾帧抽取将依赖系统 ffmpeg");
    return;
  }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    console.warn("⚠️ ffmpeg-static 未提供可用二进制，视频尾帧抽取将依赖系统 ffmpeg");
    return;
  }

  const targetPath = path.resolve("data/serve/ffmpeg");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(ffmpegPath, targetPath);
  fs.chmodSync(targetPath, 0o755);
  console.log(`✅ ffmpeg 二进制已复制: ${targetPath}`);
}

(async () => {
  try {
    console.log("🔨 开始构建...\n");

    // 并行构建
    await Promise.all([esbuild.build(appBuildConfig), esbuild.build(mainBuildConfig)]);
    copyFfmpegBinary();

    console.log("✅ 后端服务构建完成: build/app.js");
    console.log("✅ Electron主进程构建完成: build/main.js");
    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
