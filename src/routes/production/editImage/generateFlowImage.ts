import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getReferenceImageBudget, urlToCompressedBase64 } from "@/utils/vm";
const router = express.Router();

type FlowImageTask =
  | { state: "生成中"; createdAt: number }
  | { state: "已完成"; createdAt: number; url: string }
  | { state: "生成失败"; createdAt: number; errorReason: string };

const flowImageTasks = new Map<string, FlowImageTask>();
const FLOW_IMAGE_TASK_TTL = 60 * 60 * 1000;

function setFlowImageTask(taskId: string, task: FlowImageTask) {
  flowImageTasks.set(taskId, task);
  setTimeout(() => flowImageTasks.delete(taskId), FLOW_IMAGE_TASK_TTL).unref?.();
}

function normalizeReferenceImageUrl(imageUrl: string): string {
  const rawUrl = String(imageUrl || "").trim();
  if (!rawUrl) return "";

  let pathname = rawUrl.split("?")[0].split("#")[0];
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {}

  if (pathname.startsWith("/oss-preview/")) {
    pathname = `/oss/${pathname.slice("/oss-preview/".length)}`;
  }
  if (pathname.startsWith("/oss/smallImage/")) {
    pathname = `/oss/${pathname.slice("/oss/smallImage/".length)}`;
  }

  if (pathname.startsWith("/oss/")) return pathname;
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : pathname;
}

async function getReferenceList(references: string[]) {
  const validReferences = references.map(normalizeReferenceImageUrl).filter(Boolean);
  const referenceBudget = getReferenceImageBudget(validReferences.length);
  const list: { type: "image"; base64: string }[] = [];
  for (const url of validReferences) {
    list.push({ type: "image", base64: await urlToCompressedBase64(url, referenceBudget) });
  }
  return list;
}

async function runFlowImageTask(
  taskId: string,
  input: { model: string; references: string[]; quality: string; ratio: string; prompt: string; projectId: number },
) {
  const { model, references, quality, ratio, prompt, projectId } = input;
  try {
    const imageClass = await u.Ai.Image(model).run(
      {
        prompt,
        referenceList: await getReferenceList(references),
        size: quality,
        aspectRatio: ratio,
      },
      {
        taskClass: "工作流图片生成",
        describe: "工作流图片生成",
        relatedObjects: JSON.stringify(input),
        projectId,
      },
    );
    const savePath = `${projectId}/workFlow/${u.uuid()}.jpg`;
    await imageClass.save(savePath);

    const url = await u.oss.getSmallImageUrl(savePath);
    setFlowImageTask(taskId, { state: "已完成", createdAt: Date.now(), url });
  } catch (e) {
    const message = u.error(e).message;
    setFlowImageTask(taskId, {
      state: "生成失败",
      createdAt: Date.now(),
      errorReason: message.includes("413") ? "参考图请求体过大：已自动压缩参考图后仍超出上游限制，请减少参考图数量或降低质量后重试" : message,
    });
  }
}

export default router.post(
  "/",
  validateFields({
    model: z.string(),
    references: z.array(z.string()).optional(),
    quality: z.string(),
    ratio: z.string(),
    prompt: z.string(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { model, references = [], quality, ratio, prompt, projectId } = req.body;
    const taskId = u.uuid();
    setFlowImageTask(taskId, { state: "生成中", createdAt: Date.now() });
    void runFlowImageTask(taskId, { model, references, quality, ratio, prompt, projectId });
    return res.status(200).send(success({ taskId, state: "生成中" }));
  },
);

router.post(
  "/poll",
  validateFields({
    taskId: z.string(),
  }),
  async (req, res) => {
    const task = flowImageTasks.get(req.body.taskId);
    if (!task) return res.status(404).send(error("未找到图片生成任务，请重新生成"));
    return res.status(200).send(success(task));
  },
);
