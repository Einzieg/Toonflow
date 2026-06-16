import { tool, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import { expandStoryboardItemsForDuration, planStoryboardTrackSegments } from "@/utils/storyboardTrack";
import { normalizeStoryboardAssociateAssets, type StoryboardAssetProjectAsset } from "@/utils/storyboardAssetRefs";
import { buildStoryboardImagePrompt } from "@/utils/assetsPrompt";
import {
  clearStoryboardFirstWorkflow,
  getStoryboardFirstState,
  startGenerateStoryboardFirstImage,
  startGenerateStoryboardFirstScript,
  startGenerateStoryboardFirstVideo,
  updateStoryboardFirstScript,
} from "@/utils/storyboardFirst";

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

interface ParsedStoryboardTableRow {
  no: number;
  description: string;
  scene: string;
  assetNames: string;
  duration: number;
  shot: string;
  camera: string;
  action: string;
  emotion: string;
  lighting: string;
  dialogue: string;
  sound: string;
  associateAssetsIds: number[];
}

type ExpandedStoryboardTableRow = ParsedStoryboardTableRow & {
  expandedIndex: number;
  originalDuration: number;
  splitIndex: number;
  splitCount: number;
};

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

function normalizeUserCommand(content: string) {
  return String(content || "").replace(/\s+/g, "");
}

function isExplicitStoryboardClearRequest(content: string) {
  const text = normalizeUserCommand(content);
  if (!text) return false;

  const isInvestigationOnly = /(为什么|为何|怎么会|怎么又|排查|查一下|看下|原因|问题|未操作|没操作|没有操作|自动|情况)/.test(text);
  const investigationWords = "为什么|为何|怎么|排查|查一下|看下|原因|问题|情况|未操作|没操作|没有操作|自动";
  const destructiveWords = "清空|删除|删掉|移除|重置|重做|重写|重新生成|重新制作|重新执行|重新跑|重跑|从头";
  const directDestructiveIntent =
    new RegExp(
      `(帮我|请|需要|我要|我想|先|直接|现在|把|将)(?:(?!${investigationWords}).){0,12}(${destructiveWords})`,
    ).test(
      text,
    ) || new RegExp(`^(${destructiveWords})`).test(text);
  const mentionsStoryboardClear =
    new RegExp(`(${destructiveWords}).{0,16}(分镜面板|分镜|阶段5)`).test(text) ||
    new RegExp(`(分镜面板|分镜|阶段5).{0,16}(${destructiveWords})`).test(text);

  if (isInvestigationOnly && !directDestructiveIntent) return false;
  return directDestructiveIntent && mentionsStoryboardClear;
}

function isStoryboardClearConfirmation(content: string) {
  const text = normalizeUserCommand(content);
  return /(确认|同意|可以|继续|执行|开始|后续自动推进|自动推进|按这个|就这样)/.test(text);
}

function hasRecentStoryboardClearAuthorization(messages: Array<{ content: string; createTime: number }>) {
  const [latest] = messages;
  if (!latest) return false;
  if (isExplicitStoryboardClearRequest(latest.content)) return true;
  if (!isStoryboardClearConfirmation(latest.content)) return false;

  const latestTime = Number(latest.createTime || Date.now());
  const authorizationWindowMs = 6 * 60 * 60 * 1000;
  return messages.slice(1).some((message) => {
    const messageTime = Number(message.createTime || 0);
    return latestTime - messageTime <= authorizationWindowMs && isExplicitStoryboardClearRequest(message.content);
  });
}

function isStoryboardFirstRequest(content: string) {
  const text = normalizeUserCommand(content);
  return /(故事板先行|先出故事板|从剧本生成故事板图片|故事板转视频|单图故事板)/.test(text);
}

function truncateText(value: string, maxLength: number) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseAssetIds(value: string) {
  return Array.from(new Set((value.match(/\d+/g) ?? []).map(Number).filter((id) => Number.isInteger(id))));
}

function parseStoryboardTableRows(content: string): ParsedStoryboardTableRow[] {
  return String(content || "")
    .split(/\r?\n/)
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => splitMarkdownTableRow(line))
    .filter((cells) => cells.length >= 13 && Number.isInteger(Number(cells[0])))
    .map((cells) => ({
      no: Number(cells[0]),
      description: cells[1] ?? "",
      scene: cells[2] ?? "",
      assetNames: cells[3] ?? "",
      duration: Number(String(cells[4] ?? "").match(/\d+(\.\d+)?/)?.[0] ?? 0),
      shot: cells[5] ?? "",
      camera: cells[6] ?? "",
      action: cells[7] ?? "",
      emotion: cells[8] ?? "",
      lighting: cells[9] ?? "",
      dialogue: cells[10] ?? "",
      sound: cells[11] ?? "",
      associateAssetsIds: parseAssetIds(cells[12] ?? ""),
    }));
}

function expandStoryboardTableRows(rows: ParsedStoryboardTableRow[]): ExpandedStoryboardTableRow[] {
  let expandedIndex = 0;
  return rows.flatMap((row) => {
    const chunks = expandStoryboardItemsForDuration([row]);
    return chunks.map((chunk, splitIndex) => ({
      ...row,
      duration: chunk.duration,
      expandedIndex: expandedIndex++,
      originalDuration: row.duration,
      splitIndex,
      splitCount: chunks.length,
    }));
  });
}

function buildStoryboardVideoDesc(row: ParsedStoryboardTableRow | ExpandedStoryboardTableRow) {
  return truncateText(
    [
      `【画面】${row.description}`,
      `【场景】${row.scene}`,
      `【镜头】${row.shot}，${row.camera}`,
      `【动作】${row.action}`,
      `【情绪】${row.emotion}`,
      `【光影】${row.lighting}`,
      row.dialogue && row.dialogue !== "无台词" ? `【台词】${row.dialogue}` : "",
      row.sound && row.sound !== "无音效" ? `【音效】${row.sound}` : "",
      `【关联资产ID】[${row.associateAssetsIds.join(", ")}]`,
      "splitCount" in row && row.splitCount > 1
        ? `【时长拆分】原分镜 ${row.originalDuration}s，第 ${row.splitIndex + 1}/${row.splitCount} 段，本段 ${row.duration}s`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    800,
  );
}

function buildStoryboardPrompt(row: ParsedStoryboardTableRow, assetMap: Map<number, StoryboardAssetProjectAsset>, artStyle?: string | null) {
  const refs = row.associateAssetsIds
    .map((assetId, index) => {
      const asset = assetMap.get(assetId);
      const typeLabel = asset?.type === "scene" ? "场景" : asset?.type === "tool" ? "道具" : "角色";
      return `@图${index + 1} 为${asset?.name ?? `资产${assetId}`}${typeLabel}`;
    })
    .join(" ");

  const basePrompt = [
    refs,
    `首帧画面：${row.description}`,
    `场景：${row.scene}；景别：${row.shot}；运镜：${row.camera}。`,
    `角色动作与朝向：${row.action}`,
    `情绪：${row.emotion}；光影氛围：${row.lighting}`,
    "严格忠实分镜表，不新增角色、道具、场景或剧情结论。画面无文字、无水印、无多余肢体。",
  ]
    .filter(Boolean)
    .join(" ");

  return truncateText(buildStoryboardImagePrompt(basePrompt, artStyle), 900);
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const { socket } = resTool;
  const getRecentUserMessages = async () => {
    const { projectId, scriptId } = resTool.data;
    const isolationKey = `${projectId}:productionAgent:${scriptId}`;
    const rows = await u
      .db("memories")
      .where({ isolationKey, type: "message", role: "user" })
      .orderBy("createTime", "desc")
      .limit(8);
    return rows.map((row: any) => ({
      content: String(row?.content ?? ""),
      createTime: Number(row?.createTime ?? 0),
    }));
  };
  const latestUserMessageText = async () => (await getRecentUserMessages())[0]?.content ?? "";
  const shouldBlockStoryboardPanelTool = async () => isStoryboardFirstRequest(await latestUserMessageText());
  const blockStoryboardPanelTool = (thinking: ReturnType<typeof msg.thinking>, toolName: string) => {
    thinking.updateTitle("工具调用已拦截");
    thinking.appendText(`${toolName} 属于分镜面板流程，但最近用户消息处于“故事板先行”语境，应改用 storyboard_first 工具。`);
    thinking.complete();
    return "已拦截：当前是故事板先行工作流，请使用 get_storyboard_first_state / generate_storyboard_first_script / generate_storyboard_first_image / generate_storyboard_first_video / clear_storyboard_first_workflow。";
  };
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
  const syncStoryboardTracks = async (projectId: number, scriptId: number) => {
    const storyboardRows = await u
      .db("o_storyboard")
      .where({ projectId, scriptId })
      .orderBy("index", "asc")
      .select("id", "index", "track", "trackId", "duration");

    const plannedSegments = planStoryboardTrackSegments(storyboardRows);
    const reusedTrackIds = new Set<number>();

    for (const segment of plannedSegments) {
      const storyboardIds = segment.items.map((item) => item.id).filter((id): id is number => id != null);
      if (!storyboardIds.length) continue;

      const candidateTrackId =
        segment.items
          .map((item) => item.trackId)
          .find((trackId): trackId is number => trackId != null && !reusedTrackIds.has(trackId)) ?? null;

      let trackId = candidateTrackId;
      if (trackId == null) {
        const [newTrackId] = await u.db("o_videoTrack").insert({
          scriptId,
          projectId,
          duration: segment.duration,
        });
        trackId = newTrackId;
      } else {
        const membershipChanged = segment.items.some((item) => item.trackId !== trackId || String(item.track ?? "") !== segment.trackLabel);
        await u
          .db("o_videoTrack")
          .where("id", trackId)
          .update({
            duration: segment.duration,
            ...(membershipChanged
              ? {
                  prompt: "",
                  reason: null,
                  state: null,
                  videoId: null,
                  selectVideoId: null,
                }
              : {}),
          });
      }

      reusedTrackIds.add(trackId);
      await u.db("o_storyboard").whereIn("id", storyboardIds).update({
        trackId,
        track: segment.trackLabel,
      });
    }

    const existingTrackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
    const staleTrackIds = existingTrackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id) && !reusedTrackIds.has(id));
    if (staleTrackIds.length) {
      const trackIdsWithVideos = new Set(
        (await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", staleTrackIds).select("videoTrackId")).map((item: any) =>
          Number(item.videoTrackId),
        ),
      );
      const emptyStaleTrackIds = staleTrackIds.filter((trackId) => !trackIdsWithVideos.has(trackId));
      if (emptyStaleTrackIds.length) {
        await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", emptyStaleTrackIds).del();
      }
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
    if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "generate_storyboard_images");
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
    get_storyboard_first_state: tool({
      description: "读取当前剧集故事板先行工作流状态。故事板先行是独立分支，不读取分镜面板。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在读取故事板先行状态...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行状态读取失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        const data = await getStoryboardFirstState(projectId, scriptId);
        thinking.appendText(JSON.stringify(data, null, 2));
        thinking.updateTitle("故事板先行状态读取完成");
        thinking.complete();
        return data;
      },
    }),
    generate_storyboard_first_script: tool({
      description: "根据当前剧本生成故事板先行分镜脚本。不要调用分镜面板工具。",
      inputSchema: z.object({
        targetDuration: z.number().optional().describe("目标视频总时长，单位秒"),
        force: z.boolean().optional().default(false).describe("是否强制重新生成"),
      }),
      execute: async ({ targetDuration, force = false }) => {
        const thinking = msg.thinking("正在生成故事板先行分镜脚本...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行分镜脚本任务发起失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        const result = await startGenerateStoryboardFirstScript({ projectId, scriptId, targetDuration, force });
        const data = await getStoryboardFirstState(projectId, scriptId);
        thinking.appendText(`任务已发起，firstScriptId=${result.id}，reused=${result.reused}\n${JSON.stringify(data.script, null, 2)}`);
        thinking.updateTitle("故事板先行分镜脚本任务已发起");
        thinking.complete();
        return {
          state: data.script?.state || "生成中",
          firstScriptId: result.id,
          message: result.reused ? "已有故事板先行分镜脚本任务或结果" : "已开始生成故事板先行分镜脚本",
        };
      },
    }),
    update_storyboard_first_script: tool({
      description: "写入用户修订后的故事板先行分镜脚本，并使下游图片/视频动态过期。",
      inputSchema: z.object({
        firstScriptId: z.number(),
        shotScript: z.string().min(1),
      }),
      execute: async ({ firstScriptId, shotScript }) => {
        const thinking = msg.thinking("正在更新故事板先行分镜脚本...");
        await updateStoryboardFirstScript(firstScriptId, shotScript);
        thinking.updateTitle("故事板先行分镜脚本已更新");
        thinking.complete();
        return { state: "已完成", firstScriptId, message: "故事板先行分镜脚本已更新，下游图片/视频需重新生成" };
      },
    }),
    clear_storyboard_first_workflow: tool({
      description: "清空当前剧集故事板先行产物。只清理故事板先行三表和关联视频，不删除分镜面板。",
      inputSchema: z.object({
        confirm: z.literal(true),
      }),
      execute: async ({ confirm }) => {
        const thinking = msg.thinking("正在清空故事板先行工作流...");
        const { projectId, scriptId } = resTool.data;
        if (!projectId || !scriptId) {
          thinking.updateTitle("故事板先行工作流清空失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文";
        }
        await clearStoryboardFirstWorkflow(projectId, scriptId, confirm);
        thinking.updateTitle("故事板先行工作流已清空");
        thinking.complete();
        return { state: "未生成", message: "故事板先行工作流已清空" };
      },
    }),
    generate_storyboard_first_image: tool({
      description: "根据故事板先行分镜脚本生成或重生成竖版故事板图片。",
      inputSchema: z.object({
        firstScriptId: z.number(),
        force: z.boolean().optional().default(false),
      }),
      execute: async ({ firstScriptId, force = false }) => {
        const thinking = msg.thinking("正在生成故事板先行图片...");
        const result = await startGenerateStoryboardFirstImage(firstScriptId, force);
        thinking.updateTitle("故事板先行图片任务已发起");
        thinking.appendText(`firstImageId=${result.id}，reused=${result.reused}`);
        thinking.complete();
        return {
          state: "生成中",
          firstImageId: result.id,
          message: result.reused ? "已有故事板先行图片任务或结果" : "已开始生成故事板先行图片",
        };
      },
    }),
    generate_storyboard_first_video: tool({
      description: "根据故事板先行图片生成视频。这是故事板先行转视频专用工具，不写入主视频工作台。",
      inputSchema: z.object({
        firstImageId: z.number(),
        model: z.string(),
        duration: z.number(),
        resolution: z.string(),
        audio: z.boolean().optional().default(false),
      }),
      execute: async ({ firstImageId, model, duration, resolution, audio = false }) => {
        const thinking = msg.thinking("正在生成故事板先行视频...");
        const result = await startGenerateStoryboardFirstVideo({ firstImageId, model, duration, resolution, audio });
        thinking.updateTitle("故事板先行视频任务已发起");
        thinking.appendText(`firstVideoId=${result.id}，videoId=${result.videoId}，reused=${result.reused}`);
        thinking.complete();
        return {
          state: "生成中",
          firstVideoId: result.id,
          videoId: result.videoId,
          message: result.reused ? "已有故事板先行视频任务" : "已开始生成故事板先行视频",
        };
      },
    }),
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
        "清空当前项目当前剧本的分镜面板。仅当最近用户消息明确要求清空/删除/重写/重新生成分镜面板，或重新执行/重跑阶段5时才允许调用；若最新消息是确认/自动推进，可沿用最近的明确授权。会同步删除旧分镜、分镜资产关联、视频轨道和关联视频，避免新分镜追加到旧分镜后面。",
      inputSchema: z.object({}),
      execute: async () => {
        const thinking = msg.thinking("正在清空分镜面板...");
        const { projectId, scriptId } = resTool.data;
        if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "clear_storyboard_panel");
        if (!projectId || !scriptId) {
          thinking.updateTitle("清空分镜面板失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文，无法清空分镜面板";
        }

        const recentUserMessages = await getRecentUserMessages();
        const latestUserMessage = recentUserMessages[0]?.content ?? "";
        if (!hasRecentStoryboardClearAuthorization(recentUserMessages)) {
          console.warn(
            `[productionAgent.clear_storyboard_panel] blocked projectId=${projectId} scriptId=${scriptId} latestUserMessage=${JSON.stringify(
              latestUserMessage.slice(0, 160),
            )}`,
          );
          thinking.updateTitle("清空分镜面板已拦截");
          thinking.appendText(
            `最近一条用户消息未明确要求清空/删除/重写分镜面板，已阻止破坏性操作。最近消息：${latestUserMessage.slice(0, 120) || "空"}`,
          );
          thinking.complete();
          return "已拦截：清空分镜面板属于破坏性操作，必须由用户在最近消息中明确要求清空、删除、重写、重新执行阶段5或重新生成分镜面板。";
        }

        const storyboardRows = await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "trackId");
        const storyboardIds = storyboardRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
        const trackIdsFromStoryboard = storyboardRows.map((item: any) => Number(item.trackId)).filter((id) => Number.isInteger(id));
        const trackRows = await u.db("o_videoTrack").where({ projectId, scriptId }).select("id");
        const trackIds = _.uniq([...trackIdsFromStoryboard, ...trackRows.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id))]);

        console.log(
          `[productionAgent.clear_storyboard_panel] allowed projectId=${projectId} scriptId=${scriptId} storyboardCount=${storyboardIds.length} trackCount=${trackIds.length}`,
        );

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
    set_storyboard_panel_from_table: tool({
      description:
        "从当前工作区分镜表结构化写入分镜面板，替代大段 storyboardItem XML 输出。阶段5应优先调用此工具；可一次性写入全部行或补齐缺失行。",
      inputSchema: z.object({
        startNo: z.number().int().positive().optional().describe("起始分镜序号，1-based；不传则从第一条开始"),
        endNo: z.number().int().positive().optional().describe("结束分镜序号，1-based；不传则写到最后一条"),
        replaceAll: z.boolean().optional().default(false).describe("是否先清空当前分镜面板后重写全部行。破坏性操作，需最近用户明确授权"),
      }),
      execute: async ({ startNo, endNo, replaceAll = false }) => {
        const thinking = msg.thinking("正在结构化写入分镜面板...");
        const { projectId, scriptId } = resTool.data;
        if (await shouldBlockStoryboardPanelTool()) return blockStoryboardPanelTool(thinking, "set_storyboard_panel_from_table");
        if (!projectId || !scriptId) {
          thinking.updateTitle("分镜面板写入失败");
          thinking.appendText("缺少项目或剧本上下文");
          thinking.complete();
          return "缺少项目或剧本上下文，无法写入分镜面板";
        }

        if (replaceAll) {
          const recentUserMessages = await getRecentUserMessages();
          const latestUserMessage = recentUserMessages[0]?.content ?? "";
          if (!hasRecentStoryboardClearAuthorization(recentUserMessages)) {
            thinking.updateTitle("分镜面板重写已拦截");
            thinking.appendText(`最近一条用户消息未明确授权清空/重写分镜面板：${latestUserMessage.slice(0, 120) || "空"}`);
            thinking.complete();
            return "已拦截：replaceAll 会清空分镜面板，必须由用户在最近消息中明确要求清空、删除、重写、重新执行阶段5或重新生成分镜面板。";
          }
        }

        const { existing, data } = await getAgentWorkData();
        const storyboardTable = String(data.storyboardTable || "");
        const tableRows = parseStoryboardTableRows(storyboardTable);
        if (!tableRows.length) {
          thinking.updateTitle("分镜面板写入失败");
          thinking.appendText("当前工作区未解析到有效分镜表行");
          thinking.complete();
          return "写入失败：当前工作区未解析到有效分镜表行";
        }

        const expandedTableRows = expandStoryboardTableRows(tableRows);
        const selectedRows = expandedTableRows.filter((row) => row.no >= (startNo ?? 1) && row.no <= (endNo ?? Number.MAX_SAFE_INTEGER));
        if (!selectedRows.length) {
          thinking.updateTitle("分镜面板写入失败");
          thinking.appendText("指定范围内没有可写入的分镜表行");
          thinking.complete();
          return "写入失败：指定范围内没有可写入的分镜表行";
        }

        const existingStoryboards = await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "index", "trackId");
        if (replaceAll && existingStoryboards.length) {
          const storyboardIds = existingStoryboards.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
          const trackIds = existingStoryboards.map((item: any) => Number(item.trackId)).filter((id) => Number.isInteger(id));
          if (storyboardIds.length) {
            await u.db("o_assets2Storyboard").whereIn("storyboardId", storyboardIds).del();
            await u.db("o_storyboard").whereIn("id", storyboardIds).del();
          }
          if (trackIds.length) {
            await u.db("o_video").where({ projectId, scriptId }).whereIn("videoTrackId", trackIds).del();
            await u.db("o_videoTrack").where({ projectId, scriptId }).whereIn("id", trackIds).del();
          }
        }

        const currentRows = replaceAll
          ? []
          : await u.db("o_storyboard").where({ projectId, scriptId }).select("id", "index");
        const existingIndexes = new Set(currentRows.map((item: any) => Number(item.index)).filter((index) => Number.isInteger(index)));
        const projectSettingData = await u.db("o_project").where("id", projectId).select("artStyle").first();
        const projectAssets: StoryboardAssetProjectAsset[] = await u.db("o_assets").where({ projectId }).select("id", "name", "type");
        const assetMap = new Map(projectAssets.map((asset) => [Number(asset.id), asset]));
        const insertedIds: number[] = [];

        for (const row of selectedRows) {
          const rowIndex = row.expandedIndex;
          if (existingIndexes.has(rowIndex)) continue;

          const prompt = buildStoryboardPrompt(row, assetMap, projectSettingData?.artStyle);
          const videoDesc = buildStoryboardVideoDesc(row);
          const normalizedAssociateAssetsIds = normalizeStoryboardAssociateAssets(
            {
              associateAssetsIds: row.associateAssetsIds,
              prompt,
              videoDesc,
            },
            projectAssets,
          );
          const uniqueAssetIds = Array.from(
            new Set(normalizedAssociateAssetsIds.filter((assetId): assetId is number => Number.isInteger(assetId))),
          );
          const [insertedId] = await u.db("o_storyboard").insert({
            prompt,
            duration: String(row.duration || 1),
            state: "未生成",
            scriptId,
            projectId,
            index: rowIndex,
            track: "__AUTO__",
            videoDesc,
            shouldGenerateImage: 1,
            createTime: Date.now(),
          });
          const storyboardId = Number(insertedId);
          insertedIds.push(storyboardId);
          if (uniqueAssetIds.length) {
            await u.db("o_assets2Storyboard").insert(
              uniqueAssetIds.map((assetId: number) => ({
                assetId,
                storyboardId,
              })),
            );
          }
        }

        await syncStoryboardTracks(projectId, scriptId);
        data.storyboard = [];
        await saveAgentWorkData(existing, data);
        await emitClientEvent("setStoryboardPanel", {
          projectId,
          scriptId,
          insertedCount: insertedIds.length,
          totalCount: await u.db("o_storyboard").where({ projectId, scriptId }).count<{ count: number }>("id as count").first(),
        });

        const totalCountRow = await u.db("o_storyboard").where({ projectId, scriptId }).count<{ count: number }>("id as count").first();
        const totalCount = Number((totalCountRow as any)?.count ?? 0);
        thinking.appendText(`本次写入 ${insertedIds.length} 条，当前分镜面板共 ${totalCount} 条。`);
        thinking.updateTitle("分镜面板写入完成");
        thinking.complete();
        return `分镜面板写入完成：本次 ${insertedIds.length} 条，当前共 ${totalCount} 条。`;
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
