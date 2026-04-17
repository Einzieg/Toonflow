import fs from "node:fs/promises";
import path from "node:path";
import getPath from "@/utils/getPath";
import u from "@/utils";

const REQUIRED_ENV_KEYS = ["OSS_COS_BUCKET", "OSS_COS_REGION", "OSS_COS_SECRET_ID", "OSS_COS_SECRET_KEY"] as const;

function toPosixPath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

async function collectFiles(absDir: string, relDir = ""): Promise<string[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absChildPath = path.join(absDir, entry.name);
    const relChildPath = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absChildPath, relChildPath)));
    } else if (entry.isFile()) {
      files.push(toPosixPath(relChildPath));
    }
  }

  return files;
}

async function main() {
  if (process.env.OSS_PROVIDER !== "tencent-cos") {
    throw new Error("请先设置 OSS_PROVIDER=tencent-cos，再执行历史文件同步。");
  }

  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => !String(process.env[key] || "").trim());
  if (missingKeys.length) {
    throw new Error(`缺少 COS 配置：${missingKeys.join(", ")}`);
  }

  const rootDir = getPath("oss");
  await fs.mkdir(rootDir, { recursive: true });
  const files = await collectFiles(rootDir);

  if (!files.length) {
    console.log("[sync:oss:cos] data/oss 目录为空，无需同步。");
    return;
  }

  const concurrency = Math.max(1, Number.parseInt(process.env.OSS_SYNC_CONCURRENCY || "4", 10) || 4);
  const failures: Array<{ file: string; reason: string }> = [];
  let cursor = 0;
  let completed = 0;

  console.log(`[sync:oss:cos] 待同步文件数: ${files.length}, 并发: ${concurrency}`);

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;

      const relPath = files[index];

      try {
        const buffer = await fs.readFile(path.join(rootDir, relPath));
        await u.oss.writeFile(relPath, buffer);
      } catch (error) {
        failures.push({
          file: relPath,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        completed += 1;
        if (completed % 20 === 0 || completed === files.length) {
          console.log(`[sync:oss:cos] 已完成 ${completed}/${files.length}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => await worker()));

  if (failures.length) {
    console.error(`[sync:oss:cos] 同步完成，但有 ${failures.length} 个文件失败。`);
    failures.slice(0, 20).forEach((item) => {
      console.error(`- ${item.file}: ${item.reason}`);
    });
    if (failures.length > 20) {
      console.error(`[sync:oss:cos] 其余失败项已省略，请重新执行同步。`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[sync:oss:cos] 历史 OSS 文件已全部同步到 COS。");
}

main().catch((error) => {
  console.error("[sync:oss:cos] 同步失败:", error instanceof Error ? error.message : error);
  process.exit(1);
});
