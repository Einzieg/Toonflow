import { tool, Tool } from "ai";
import u from "@/utils";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import { syncProductionScriptToWorkData } from "@/utils/productionWorkDataSync";

export const ScriptSchema = z.object({
  name: z.string().describe("剧本名称"),
  content: z.string().describe("剧本内容"),
});
export const planData = z.object({
  storySkeleton: z.string().describe("故事骨架"),
  adaptationStrategy: z.string().describe("改编策略"),
  script: z.string().describe("剧本内容"),
});

export type planData = z.infer<typeof planData>;

const keySchema = z.enum(Object.keys(planData.shape) as [keyof planData, ...Array<keyof planData>]);
const planDataKeyLabels = Object.fromEntries(
  Object.entries(planData.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof planData, string>;

const normalizePlanContent = (content: string) => String(content || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const emitClientEvent = async (eventName: string, data: Record<string, any>) => {
    await Promise.race([
      new Promise((resolve) => socket.emit(eventName, data, (res: any) => resolve(res))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  };
  const getAgentWorkData = async () => {
    const projectId = Number(resTool.data.projectId);
    const existing = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    let data: Record<string, any> = {
      storySkeleton: "",
      adaptationStrategy: "",
      script: [],
    };
    if (existing?.data) {
      try {
        data = { ...data, ...JSON.parse(existing.data) };
      } catch {
        // Keep defaults when legacy data is malformed.
      }
    }
    return { projectId, existing, data };
  };
  const saveAgentWorkData = async (existing: any, projectId: number, data: Record<string, any>) => {
    if (existing) {
      await u
        .db("o_agentWorkData")
        .where({ projectId, key: "scriptAgent" })
        .update({ data: JSON.stringify(data), updateTime: Date.now() });
    } else {
      await u.db("o_agentWorkData").insert({
        projectId,
        key: "scriptAgent",
        data: JSON.stringify(data),
        createTime: Date.now(),
        updateTime: Date.now(),
      });
    }
  };
  const writeScriptItems = async (
    projectId: number,
    items: Array<{ id?: number; name: string; content: string }>,
  ): Promise<Array<{ id: number; name: string; content: string }>> => {
    const saved: Array<{ id: number; name: string; content: string }> = [];
    for (const item of items) {
      const name = item.name.trim();
      const content = item.content.trim();
      const existing = item.id
        ? await u.db("o_script").where({ projectId, id: item.id }).first()
        : await u.db("o_script").where({ projectId, name }).first();

      if (existing?.id != null) {
        await u.db("o_script").where({ projectId, id: existing.id }).update({ name, content });
        await syncProductionScriptToWorkData({ projectId, scriptId: existing.id, content });
        saved.push({ id: Number(existing.id), name, content });
      } else {
        const [id] = await u.db("o_script").insert({ projectId, name, content });
        saved.push({ id: Number(id), name, content });
      }
    }

    const { existing, data } = await getAgentWorkData();
    data.script = await u.db("o_script").where({ projectId }).select("id", "name", "content");
    await saveAgentWorkData(existing, projectId, data);
    await emitClientEvent("setScriptItems", { projectId, items: saved });
    return saved;
  };
  const tools: Record<string, Tool> = {
    get_novel_events: tool({
      description: "获取章节事件",
      inputSchema: z.object({
        chapterIndexs: z.array(z.number()).describe("章节的编号"),
      }),
      execute: async ({ chapterIndexs }) => {
        console.log("[tools] get_novel_events", chapterIndexs);
        const thinking = msg.thinking("正在查询章节事件...");
        const data = await u
          .db("o_novel")
          .where("projectId", resTool.data.projectId)
          .select("id", "chapterIndex as index", "reel", "chapter", "chapterData", "event", "eventState")
          .whereIn("chapterIndex", chapterIndexs);
        thinking.appendText("正在查询章节编号: " + chapterIndexs.join(","));
        const eventString = data.map((i: any) => [`第${i.index}章，标题：${i.chapter}，事件：${i.event}`].join("\n")).join("\n");
        thinking.appendText("查询结果:\n" + eventString);
        thinking.updateTitle("查询章节事件完成");
        thinking.complete();
        return eventString ?? "无数据";
      },
    }),
    get_planData: tool({
      description: "获取工作区数据",
      inputSchema: z.object({
        key: keySchema.describe("数据key"),
      }),
      execute: async ({ key }) => {
        console.log("[tools] get_planData", key);
        const thinking = msg.thinking(`正在获取${planDataKeyLabels[key]}工作区数据...`);
        const planData: planData = await new Promise((resolve) => socket.emit("getPlanData", { key }, (res: any) => resolve(res)));
        thinking.appendText(`获取到${planDataKeyLabels[key]}:\n` + planData[key]);
        thinking.updateTitle(`获取${planDataKeyLabels[key]}完成`);
        thinking.complete();
        return planData[key] ?? "无数据";
      },
    }),
    set_story_skeleton: tool({
      description: "写入故事骨架。用于替代 <storySkeleton> XML 输出。",
      inputSchema: z.object({
        content: z.string().min(120).describe("完整故事骨架正文"),
      }),
      execute: async ({ content }) => {
        const thinking = msg.thinking("正在写入故事骨架...");
        const { projectId, existing, data } = await getAgentWorkData();
        if (!Number.isInteger(projectId)) {
          thinking.updateTitle("故事骨架写入失败");
          thinking.appendText("缺少项目上下文");
          thinking.complete();
          return "故事骨架写入失败：缺少项目上下文";
        }
        data.storySkeleton = normalizePlanContent(content);
        await saveAgentWorkData(existing, projectId, data);
        await emitClientEvent("setStorySkeleton", { projectId, content: data.storySkeleton });
        thinking.updateTitle("故事骨架写入完成");
        thinking.appendText(`已写入 ${data.storySkeleton.length} 字。`);
        thinking.complete();
        return `故事骨架写入完成：${data.storySkeleton.length} 字。`;
      },
    }),
    append_story_skeleton_chunk: tool({
      description:
        "分段写入故事骨架。长剧本、多章节或多集项目使用：第一段用 mode=replace 覆盖旧骨架，后续段用 mode=append 追加，最后一段设置 isFinal=true。",
      inputSchema: z.object({
        content: z.string().min(40).describe("本段故事骨架正文。只能传本段内容，不要重复已写入段落。"),
        mode: z.enum(["replace", "append"]).default("append").describe("replace=清空旧骨架并写入首段；append=追加到当前故事骨架末尾。"),
        isFinal: z.boolean().optional().default(false).describe("是否为最后一段。最后一段写入完成后传 true。"),
      }),
      execute: async ({ content, mode, isFinal }) => {
        const thinking = msg.thinking(mode === "replace" ? "正在写入故事骨架首段..." : "正在追加故事骨架分段...");
        const { projectId, existing, data } = await getAgentWorkData();
        if (!Number.isInteger(projectId)) {
          thinking.updateTitle("故事骨架分段写入失败");
          thinking.appendText("缺少项目上下文");
          thinking.complete();
          return "故事骨架分段写入失败：缺少项目上下文";
        }

        const nextChunk = normalizePlanContent(content);
        const previous = normalizePlanContent(data.storySkeleton || "");
        data.storySkeleton = mode === "replace" || !previous ? nextChunk : `${previous}\n\n${nextChunk}`;

        await saveAgentWorkData(existing, projectId, data);
        await emitClientEvent("setStorySkeleton", { projectId, content: data.storySkeleton });

        thinking.updateTitle(isFinal ? "故事骨架分段写入完成" : "故事骨架分段已追加");
        thinking.appendText(`本段 ${nextChunk.length} 字，当前共 ${data.storySkeleton.length} 字。`);
        thinking.complete();
        if (isFinal) {
          return `故事骨架分段写入完成：当前共 ${data.storySkeleton.length} 字。`;
        }
        return `故事骨架分段已追加：本段 ${nextChunk.length} 字，当前共 ${data.storySkeleton.length} 字。请继续追加下一段，最后一段设置 isFinal=true。`;
      },
    }),
    set_adaptation_strategy: tool({
      description: "写入改编策略。用于替代 <adaptationStrategy> XML 输出。",
      inputSchema: z.object({
        content: z.string().min(80).describe("完整改编策略正文"),
      }),
      execute: async ({ content }) => {
        const thinking = msg.thinking("正在写入改编策略...");
        const { projectId, existing, data } = await getAgentWorkData();
        if (!Number.isInteger(projectId)) {
          thinking.updateTitle("改编策略写入失败");
          thinking.appendText("缺少项目上下文");
          thinking.complete();
          return "改编策略写入失败：缺少项目上下文";
        }
        data.adaptationStrategy = normalizePlanContent(content);
        await saveAgentWorkData(existing, projectId, data);
        await emitClientEvent("setAdaptationStrategy", { projectId, content: data.adaptationStrategy });
        thinking.updateTitle("改编策略写入完成");
        thinking.appendText(`已写入 ${data.adaptationStrategy.length} 字。`);
        thinking.complete();
        return `改编策略写入完成：${data.adaptationStrategy.length} 字。`;
      },
    }),
    set_script_item: tool({
      description: "逐集写入或更新单个剧本条目。长批次生成时优先使用，避免一次性大 JSON 参数导致解析失败。",
      inputSchema: z.object({
        id: z.number().int().positive().optional().describe("已有剧本 ID；更新已有剧本时传入"),
        name: z.string().min(1).describe("剧本名称"),
        content: z.string().min(80).describe("完整剧本正文"),
      }),
      execute: async (item) => {
        const thinking = msg.thinking("正在写入单集剧本...");
        const projectId = Number(resTool.data.projectId);
        if (!Number.isInteger(projectId)) {
          thinking.updateTitle("剧本写入失败");
          thinking.appendText("缺少项目上下文");
          thinking.complete();
          return "剧本写入失败：缺少项目上下文";
        }

        const [saved] = await writeScriptItems(projectId, [item]);
        thinking.updateTitle("单集剧本写入完成");
        thinking.appendText(`已写入/更新 ${saved.id}:${saved.name}。`);
        thinking.complete();
        return `单集剧本写入完成：${saved.id}:${saved.name}。`;
      },
    }),
    set_script_items: tool({
      description: "批量写入或更新剧本条目。仅用于短内容兼容；长批次优先使用 set_script_item 逐集写入。",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              id: z.number().int().positive().optional().describe("已有剧本 ID；更新已有剧本时传入"),
              name: z.string().min(1).describe("剧本名称"),
              content: z.string().min(80).describe("完整剧本正文"),
            }),
          )
          .min(1)
          .describe("要写入的剧本列表"),
      }),
      execute: async ({ items }) => {
        const thinking = msg.thinking("正在写入剧本...");
        const projectId = Number(resTool.data.projectId);
        if (!Number.isInteger(projectId)) {
          thinking.updateTitle("剧本写入失败");
          thinking.appendText("缺少项目上下文");
          thinking.complete();
          return "剧本写入失败：缺少项目上下文";
        }

        const saved = await writeScriptItems(projectId, items);

        thinking.updateTitle("剧本写入完成");
        thinking.appendText(`已写入/更新 ${saved.length} 条剧本。`);
        thinking.complete();
        return `剧本写入完成：${saved.map((item) => `${item.id}:${item.name}`).join("、")}。`;
      },
    }),
    get_novel_text: tool({
      description: "获取小说章节原始文本内容",
      inputSchema: z.object({
        chapterIndex: z.string().describe("章节编号"),
      }),
      execute: async ({ chapterIndex }) => {
        console.log("[tools] get_novel_text", "[tools] get_novel_text", chapterIndex);
        const thinking = msg.thinking(`正在获取小说章节原文...`);
        const data = await u.db("o_novel").where("projectId", resTool.data.projectId).where({ chapterIndex }).select("chapterData").first();
        const text = data && data?.chapterData ? data.chapterData : "";
        thinking.appendText(`获取到原文:\n` + text);
        thinking.updateTitle(`获取小说章节原文完成`);
        thinking.complete();
        return text ?? "无数据";
      },
    }),
    get_script_content: tool({
      description: "获取剧本本内容",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("脚本id"),
      }),
      execute: async ({ ids }) => {
        console.log("[tools] get_script_content", "[tools] get_script_content", ids);
        const thinking = msg.thinking(`正在获取脚本内容...`);
        const data = await u.db("o_script").whereIn("id", ids).select("content", "name");
        const text =
          data && data.length
            ? data
                .map((d) =>
                  [
                    `## ${d.name}`,
                    "```text",
                    d.content,
                    "```",
                  ].join("\n"),
                )
                .join("\n\n")
            : "";
        thinking.appendText(`获取到脚本内容:\n` + JSON.stringify(data, null, 2));
        thinking.updateTitle(`获取脚本内容完成`);
        thinking.complete();
        return text ?? "无数据";
      },
    }),
  };
  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
