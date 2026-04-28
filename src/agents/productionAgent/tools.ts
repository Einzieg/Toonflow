import { tool, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  volcengineAssetUri: z.string().nullable().optional().describe("火山引擎官方虚拟人像URI，仅真人/角色视频生成阶段使用"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  volcengineAssetUri: z.string().nullable().optional().describe("火山引擎官方虚拟人像URI，仅真人/角色视频生成阶段使用"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).optional().describe("分镜图片生成状态"),
  shouldGenerateImage: z.number().optional().describe("是否需要生成分镜图，1为需要"),
  track: z.string().nullable().optional().describe("分镜所属轨道分组"),
  videoDesc: z.string().optional().describe("分镜画面描述"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const getAgentWorkData = async () => {
    const { projectId, scriptId } = resTool.data;
    const existing = await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .where("episodesId", String(scriptId))
      .where("key", "productionAgent")
      .first();
    let data: Record<string, any> = {};

    if (existing?.data) {
      try {
        data = JSON.parse(existing.data);
      } catch {
        data = {};
      }
    }

    if (!data.script) {
      const scriptData = await u.db("o_script").where("id", scriptId).select("content").first();
      data.script = scriptData?.content ?? "";
    }
    if (!Array.isArray(data.storyboard)) data.storyboard = [];
    if (!data.workbench) data.workbench = { videoList: [] };

    return { existing, data };
  };
  const saveAgentWorkData = async (existing: any, data: Record<string, any>) => {
    const { projectId, scriptId } = resTool.data;
    if (existing) {
      await u
        .db("o_agentWorkData")
        .where("projectId", String(projectId))
        .where("episodesId", String(scriptId))
        .where("key", "productionAgent")
        .update({ data: JSON.stringify(data), updateTime: Date.now() });
    } else {
      await u.db("o_agentWorkData").insert({
        projectId,
        episodesId: scriptId,
        key: "productionAgent",
        data: JSON.stringify(data),
        createTime: Date.now(),
        updateTime: Date.now(),
      });
    }
  };
  const countStoryboardRows = (content: string) => [...content.matchAll(/^\|\s*\d+\s*\|/gm)].length;
  const storyboardGenerateInputSchema = z.object({
    ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
  });
  const executeGenerateStoryboard = async ({ ids }: { ids: number[] }) => {
    const uniqueIds = _.uniq(ids.filter((id) => Number.isInteger(id)));
    if (!uniqueIds.length) return "没有可生成的分镜";
    const thinking = msg.thinking("正在生成分镜...");
    new Promise((resolve) => socket.emit("generateStoryboard", { ids: uniqueIds }, (res: any) => resolve(res)))
      .then((res) => {
        thinking.appendText("生成的分镜数据:\n" + JSON.stringify(res, null, 2));
        thinking.updateTitle("分镜生成完成");
        thinking.complete();
      })
      .catch((e) => {
        thinking.appendText("分镜生成失败:\n" + u.error(e).message);
        thinking.updateTitle("分镜生成失败");
        thinking.complete();
      });

    return "开始生成分镜";
  };
  const emitClientEvent = async (eventName: string, data: Record<string, any>) => {
    await Promise.race([
      new Promise((resolve) => socket.emit(eventName, data, (res: any) => resolve(res))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  };
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: z.object({
        key: keySchema.describe("数据key"),
      }),
      execute: async ({ key }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);
        console.log("[tools] get_flowData", key);
        const flowData: FlowData = await new Promise((resolve) => socket.emit("getFlowData", { key }, (res: any) => resolve(res)));
        thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(flowData[key], null, 2));
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
        thinking.complete();
        return flowData[key];
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.preprocess(
          (val) => {
            if (val === "null" || val === "" || val === undefined) return null;
            return val;
          },
          z.number().nullable().describe("衍生资产ID,如果新增则为空")),
        name: z.string().describe("衍生资产名称"),
        desc: z.string().describe("衍生资产描述"),
      }),
      execute: async (deriveAsset) => {
        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const startTime = Date.now();
        const parentAssets = await u.db("o_assets").where("id", deriveAsset.assetsId).select("id", "type", "volcengineAssetUri").first();
        if (!parentAssets) return "关联的资产不存在";

        const data = {
          id: deriveAsset.id ?? undefined,
          assetsId: deriveAsset.assetsId,
          projectId,
          name: deriveAsset.name,
          type: parentAssets.type,
          describe: deriveAsset.desc,
          volcengineAssetUri: parentAssets.type === "role" ? (parentAssets.volcengineAssetUri ?? null) : null,
          startTime,
        };
        if (deriveAsset.id) {
          await u.db("o_assets").where("id", deriveAsset.id).update(data);
          thinking.appendText(`已更新衍生资产，ID: ${deriveAsset.id}\n`);
        } else {
          const [insertedId] = await u.db("o_assets").insert(data);
          data.id = insertedId;
          await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
          thinking.appendText(`已新增衍生资产，ID: ${insertedId}\n`);
        }
        const res = await new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "操作成功";
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.number().describe("衍生资产ID"),
      }),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId } = resTool.data;
        await u.db("o_assets").where("id", id).del();
        await u.db("o_scriptAssets").where({ scriptId, assetId: id }).del();
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        const res = await new Promise((resolve) => socket.emit("delDeriveAsset", { assetsId, id }, (res: any) => resolve(res)));
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return res ?? "删除成功";
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: z.object({
        ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
      }),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        new Promise((resolve) => socket.emit("generateDeriveAsset", { ids }, (res: any) => resolve(res)))
          .then((res) => {
            thinking.appendText(`已生成衍生资产，ID: ${JSON.stringify(res, null, 2)}\n`);
            thinking.updateTitle("衍生资产开始完成");
            thinking.complete();
          })
          .catch((e) => {
            thinking.appendText("衍生资产生成失败:\n" + u.error(e).message);
            thinking.updateTitle("衍生资产生成失败");
            thinking.complete();
          });

        return "开始生成衍生资产";
      },
    }),
    clear_storyboard_panel: tool({
      description:
        "清空当前项目当前剧本的分镜面板。重新生成完整分镜面板、重写阶段5、从旧分镜重新开始前必须先调用；会同步删除旧分镜、分镜资产关联、视频轨道和关联视频，避免新分镜追加到旧分镜后面。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在清空分镜面板...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("清空分镜面板失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文，无法清空分镜面板";
        }

        const storyboardRows = await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "trackId");
        const storyboardIds = storyboardRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
        const trackIdsFromStoryboard = storyboardRows.map((item: any) => Number(item.trackId)).filter((id) => Number.isInteger(id));
        const trackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
        const trackIds = _.uniq([...trackIdsFromStoryboard, ...trackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id))]);

        if (storyboardIds.length) {
          await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).del();
          await u.db("o_storyboard").whereIn("id", storyboardIds).del();
        }
        if (trackIds.length) {
          await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds).del();
          await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).del();
        }
        const { existing, data } = await getAgentWorkData();
        data.storyboard = [];
        data.workbench = { ...(data.workbench ?? {}), videoList: [] };
        await saveAgentWorkData(existing, data);

        await emitClientEvent("clearStoryboardPanel", {
          projectId,
          scriptId,
          storyboardCount: storyboardIds.length,
          trackCount: trackIds.length,
        });

        thinking.appendText(`已清空分镜 ${storyboardIds.length} 条，视频轨道 ${trackIds.length} 条。`);
        thinking.updateTitle("分镜面板已清空");
        thinking.complete();
        return `分镜面板已清空：删除分镜 ${storyboardIds.length} 条，视频轨道 ${trackIds.length} 条。`;
      },
    }),
    set_storyboard_table: tool({
      description:
        "写入当前项目当前剧本的分镜表。阶段4构建或修复分镜表时必须调用。长分镜表可分块调用：第一块 mode=replace，后续块 mode=append，避免长 XML/纯文本输出被截断后无法落库。",
      inputSchema: z.object({
        content: z.string().min(1).describe("分镜表 Markdown 表格内容，必须包含表头或连续表格行"),
        mode: z.enum(["replace", "append"]).default("replace").describe("replace 覆盖旧分镜表；append 追加到现有分镜表末尾"),
      }),
      execute: async ({ content, mode }) => {
        const thinking = msg.thinking(mode === "append" ? "正在追加分镜表..." : "正在写入分镜表...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("写入分镜表失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文，无法写入分镜表";
        }

        const normalizedContent = String(content || "").trim();
        const currentRowCount = countStoryboardRows(normalizedContent);
        if (currentRowCount === 0) {
          thinking.updateTitle("写入分镜表失败");
          thinking.appendText("内容中未检测到分镜表行");
          thinking.complete();
          return "写入失败：内容中未检测到分镜表行";
        }

        const { existing, data } = await getAgentWorkData();
        const previousContent = String(data.storyboardTable || "").trim();
        data.storyboardTable =
          mode === "append" && previousContent ? `${previousContent}\n${normalizedContent}` : normalizedContent;
        await saveAgentWorkData(existing, data);
        await emitClientEvent("setStoryboardTable", {
          projectId,
          scriptId,
          storyboardTable: data.storyboardTable,
          rowCount: countStoryboardRows(data.storyboardTable),
        });

        const totalRowCount = countStoryboardRows(data.storyboardTable);
        thinking.appendText(`本次写入 ${currentRowCount} 行，当前分镜表共 ${totalRowCount} 行。`);
        thinking.updateTitle("分镜表写入完成");
        thinking.complete();
        return `分镜表写入完成：本次 ${currentRowCount} 行，当前共 ${totalRowCount} 行。`;
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: storyboardGenerateInputSchema,
      execute: executeGenerateStoryboard,
    }),
    generate_storyboard_images: tool({
      description: "生成分镜图片（兼容旧技能名）",
      inputSchema: storyboardGenerateInputSchema,
      execute: executeGenerateStoryboard,
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};
