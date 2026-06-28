import { Socket } from "socket.io";
import { tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import useTools from "@/agents/scriptAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let memoryContext = "";
  if (mem.rag.length) {
    memoryContext += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (memoryContext) memoryContext += "\n\n";
    memoryContext += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return [
    "## Memory",
    "以下是你对用户的记忆，可作为参考但不要主动提及。",
    "优先级规则：记忆和摘要不是当前项目配置；当记忆/摘要/工作区与本轮用户明确指令或近期用户明确配置冲突时，必须以最新用户明确指令为准。",
    "如果用户最新明确修改了集数、单集时长、章节范围、画幅、风格或付费策略，旧摘要中的配置立即作废；不得静默沿用旧配置继续执行。",
    memoryContext,
  ].join("\n");
}

async function buildRecentUserConfigContext(isolationKey: string, limit = 10) {
  const rows = await u
    .db("memories")
    .where({ isolationKey, type: "message" })
    .whereIn("role", ["user", "assistant:decision"])
    .orderBy("createTime", "desc")
    .limit(limit);
  rows.reverse();
  const lines = rows.map((row: any) => {
    const role = row.role === "user" ? "用户" : "决策层";
    return `${role}: ${String(row.content || "").replace(/\s+/g, " ").trim().slice(0, 600)}`;
  });
  if (!lines.length) return "";
  return [
    "## 近期配置变更上下文",
    "下面是最近用户/决策层对话，仅用于判断当前项目配置。",
    "若出现配置冲突，最新用户明确输入的集数、时长、章节范围、画幅、风格、付费策略和改编模式优先于旧摘要、旧工作区和旧产出。",
    "若近期用户要求“忠实原著、不魔改、最小改动、小说剧情很完美、不要偏离原文”，后续派发与执行必须视为【改编模式：忠实原著】。",
    ...lines,
  ].join("\n");
}

async function canDirectRunScriptAuto(projectId: number) {
  const existing = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
  if (!existing?.data) return false;
  try {
    const data = JSON.parse(existing.data);
    return Boolean(String(data.storySkeleton || "").trim() && String(data.adaptationStrategy || "").trim());
  } catch {
    return false;
  }
}

function shouldDirectRunScriptAuto(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return /(继续自动推进|自动推进至结束|自动推进到结束|继续.*至结束|继续.*到结束|继续生成剧本|继续写剧本|续写剧本|生成剩余剧本|自动生成剩余|按5集一批)/.test(
    normalized,
  );
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, userMessageTime, abortSignal, resTool } = ctx;

  const memory = new Memory("scriptAgent", isolationKey);
  await memory.add("user", text, { createTime: userMessageTime });

  if (shouldDirectRunScriptAuto(text) && (await canDirectRunScriptAuto(Number(resTool.data.projectId)))) {
    const subAgents = createSubAgent(ctx);
    const result = await (subAgents.run_sub_agent_script_auto as any).execute({
      batchSize: 5,
      prompt: "按项目配置继续自动推进剧本至目标集数，已有集数跳过，只补缺失集。",
    });
    const content = String(result || "剧本自动推进已结束。");
    const output = ctx.msg.text();
    output.append(content);
    output.complete();
    ctx.msg.complete();
    await memory.add("assistant:decision", removeAllXmlTags(content));
    return;
  }

  const skill = path.join(u.getPath("skills"), "script_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const mem = buildMemPrompt(await memory.get(text));

  const projectData = await u.db("o_project").where("id", resTool.data.projectId).first();

  const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

  const projectInfo = [
    "## 项目信息",
    `小说名称：${projectData?.name ?? "未知"}`,
    `小说类型：${projectData?.type ?? "未知"}`,
    `小说简介：${projectData?.intro ?? "无"}`,
    `目标改编影视视觉手册|画风：${projectData?.artStyle ?? "无"}`,
    `目标改编视频画幅：${projectData?.videoRatio ?? "16:9"}`,
    `章节数量：${novelData.length}章`,
    "改编模式提示：默认常规短剧改编；若用户要求“忠实原著/不魔改/最小改动/小说剧情很完美/不要偏离原文”，必须在【项目配置】中写明“改编模式：忠实原著”。",
  ].join("\n");

  const { fullStream } = await u.Ai.Text("scriptAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: projectInfo + "\n" + mem },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...createSubAgent(ctx),
    },
    onFinish: async (completion) => {
      await memory.add("assistant:decision", removeAllXmlTags(completion.text));
    },
  });

  let currentMsg = ctx.msg;
  await consumeFullStream(fullStream, currentMsg, () => {
    if (ctx.msg === currentMsg) return currentMsg;
    currentMsg.complete();
    currentMsg = ctx.msg;
    return currentMsg;
  });
}

function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("scriptAgent", parentCtx.isolationKey);

  async function runAgent({
    key,
    prompt,
    system,
    name,
    memoryKey,
    tools: extraTools,
    messages,
  }: {
    key: `${string}:${string}`;
    prompt: string;
    system: string;
    name: string;
    memoryKey: string;
    tools?: Record<string, any>;
    messages?: { role: "user" | "assistant" | "system"; content: string }[];
  }) {
    parentCtx.msg.complete();
    const subMsg = resTool.newMessage("assistant", name);
    const recentUserConfigContext = await buildRecentUserConfigContext(parentCtx.isolationKey);
    const effectiveMessages = messages ?? [{ role: "user" as const, content: prompt }];
    const messagesWithContext =
      recentUserConfigContext || parentCtx.text
        ? [
            {
              role: "assistant" as const,
              content: [
                recentUserConfigContext,
                "## 当前用户本轮输入",
                parentCtx.text,
                "配置冲突处理：执行层不得从旧故事骨架、旧改编策略或旧摘要中反推项目配置；若本轮或近期用户明确给出新配置，必须按新配置执行。若本轮或近期用户要求忠实原著/不魔改/小说剧情很完美，必须按【改编模式：忠实原著】执行。",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            ...effectiveMessages,
          ]
        : effectiveMessages;

    const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
      system,
      messages: messagesWithContext,
      abortSignal,
      tools: { ...extraTools, ...useTools({ resTool, msg: subMsg }) },
    });

    const fullResponse = await consumeFullStream(fullStream, subMsg);

    if (fullResponse.trim()) {
      await memory.add(memoryKey, removeAllXmlTags(fullResponse), {
        name,
        createTime: new Date(subMsg.datetime).getTime(),
      });
    }

    parentCtx.msg = resTool.newMessage("assistant", "视频策划");
    return fullResponse;
  }

  const promptInput = z.object({
    prompt: z.string().describe("交给子Agent的任务简约描述，100字以内"),
  });

  const run_sub_agent_storySkeleton = tool({
    description: "运行执行subAgent来完成故事骨架相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_skeleton.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n必须调用 set_story_skeleton({ content }) 或 append_story_skeleton_chunk({ content, mode, isFinal }) 写入故事骨架。长剧本、多章节、多集或预计输出较长时，必须用 append_story_skeleton_chunk 分段写入：首段 mode=replace，后续 mode=append，最后一段 isFinal=true。禁止使用 <storySkeleton> XML 输出作为主要写入方式，禁止只返回文字确认。";

      return runAgent({
        key: "scriptAgent:storySkeletonAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:storySkeleton",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_adaptationStrategy = tool({
    description: "运行执行subAgent来完成改编策略相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_execution_adaptation.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const formatPrompt =
        "\n必须调用 set_adaptation_strategy({ content }) 写入完整改编策略。禁止使用 <adaptationStrategy> XML 输出作为主要写入方式，禁止只返回文字确认。";

      return runAgent({
        key: "scriptAgent:adaptationStrategyAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        name: "编剧",
        memoryKey: "assistant:execution:adaptationStrategy",
        messages: [{ role: "user", content: prompt + formatPrompt }],
      });
    },
  });

  const run_sub_agent_script = tool({
    description: "运行执行subAgent来完成剧本相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const numericBatchSize = prompt.trim().match(/^\d+$/);
      if (numericBatchSize) {
        const batchSize = Number(numericBatchSize[0]);
        if (Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 5) {
          return runScriptAuto({ batchSize, prompt: "按项目配置自动续写剧本，已有集数跳过，只补缺失集。" });
        }
      }
      if (shouldAutoScriptPrompt(prompt)) {
        return runScriptAuto({ batchSize: 5, prompt: "按项目配置自动续写剧本至目标集数，已有集数跳过，只补缺失集。" });
      }
      return runScriptAgent(prompt);
    },
  });

  const shouldAutoScriptPrompt = (prompt: string) => {
    const normalized = prompt.replace(/\s+/g, "");
    const explicitBatch = /第\d+[-到至—~]\d+集|(?:EP|E)\d+[-到至—~]\d+/i.test(normalized);
    const strongAuto = /(自动推进|至结束|到结束|剩余|全部|补齐|目标集数)/.test(normalized);
    const continueOnly = /(继续|续写)/.test(normalized) && !explicitBatch;
    return strongAuto || continueOnly;
  };

  const parseEpisodeNo = (name: string) => {
    const text = String(name || "");
    const match = text.match(/(?:EP|E)\s*0*(\d+)/i) || text.match(/第\s*0*(\d+)\s*集/);
    const episodeNo = match ? Number(match[1]) : NaN;
    return Number.isInteger(episodeNo) && episodeNo > 0 ? episodeNo : null;
  };

  const getScriptEpisodeMap = async () => {
    const rows = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
    const map = new Map<number, { id: number; name: string }>();
    for (const row of rows) {
      const name = String(row.name || "");
      const episodeNo = parseEpisodeNo(name);
      if (episodeNo != null && !map.has(episodeNo)) {
        map.set(episodeNo, { id: Number(row.id), name });
      }
    }
    return map;
  };

  const parseMaxEpisodeNo = (texts: string[]) => {
    let max = 0;
    const patterns = [/(?:EP|E)\s*0*(\d{1,3})/gi, /第\s*0*(\d{1,3})\s*集/g, /\|\s*(\d{1,3})\s*\|/g];
    for (const text of texts) {
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const value = Number(match[1]);
          if (Number.isInteger(value) && value > 0 && value <= 300) {
            max = Math.max(max, value);
          }
        }
      }
    }
    return max || null;
  };

  const inferScriptTargetEpisode = async () => {
    const projectId = Number(resTool.data.projectId);
    const existing = await u.db("o_agentWorkData").where({ projectId, key: "scriptAgent" }).first();
    if (!existing?.data) return null;
    try {
      const data = JSON.parse(existing.data);
      return parseMaxEpisodeNo([String(data.storySkeleton || ""), String(data.adaptationStrategy || "")]);
    } catch {
      return null;
    }
  };

  const run_sub_agent_script_auto = tool({
    description: "自动按最多5集一批运行剧本执行层，正常完成后继续下一批，直到目标集数完成。用于避免一次性生成剧本导致上下文超载。",
    inputSchema: z.object({
      startEpisode: z.number().int().positive().optional().describe("起始集数；不传则从目标范围内第一个缺失集开始"),
      endEpisode: z.number().int().positive().optional().describe("目标最后集数；不传则从故事骨架/改编策略推断"),
      batchSize: z.number().int().min(1).max(5).default(5).describe("每批最多生成几集，最大5"),
      prompt: z.string().max(240).optional().describe("额外写作要求，保持简短"),
      overwriteExisting: z.boolean().optional().default(false).describe("是否覆盖已有剧本；默认跳过已有集数，只补缺失集"),
      maxBatches: z.number().int().min(1).max(100).optional().default(50).describe("安全上限，防止异常循环"),
    }),
    execute: async ({ startEpisode, endEpisode, batchSize, prompt, overwriteExisting, maxBatches }) => {
      return runScriptAuto({ startEpisode, endEpisode, batchSize, prompt, overwriteExisting, maxBatches });
    },
  });

  async function runScriptAuto({
    startEpisode,
    endEpisode,
    batchSize = 5,
    prompt,
    overwriteExisting = false,
    maxBatches = 50,
  }: {
    startEpisode?: number;
    endEpisode?: number;
    batchSize?: number;
    prompt?: string;
    overwriteExisting?: boolean;
    maxBatches?: number;
  }) {
    const targetEndEpisode = endEpisode ?? (await inferScriptTargetEpisode());
    if (!targetEndEpisode) {
      return "剧本自动生成未启动：缺少目标集数，且无法从故事骨架/改编策略推断。";
    }
    if (startEpisode != null && startEpisode > targetEndEpisode) {
      return `剧本自动生成未启动：起始集 ${startEpisode} 大于结束集 ${targetEndEpisode}。`;
    }

    const completed: string[] = [];
    const failed: string[] = [];
    const processedEpisodes = new Set<number>();
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
      const episodeMapBefore = await getScriptEpisodeMap();
      const from = startEpisode ?? 1;
      const targetEpisodes = Array.from({ length: targetEndEpisode - from + 1 }, (_, index) => from + index).filter(
        (episodeNo) => !processedEpisodes.has(episodeNo) && (overwriteExisting || !episodeMapBefore.has(episodeNo)),
      );
      if (!targetEpisodes.length) {
        return completed.length
          ? `剧本自动生成完成：${completed.join("；")}。`
          : `剧本已完成：第${from}-${targetEndEpisode}集均已存在。`;
      }

      const batchEpisodes = targetEpisodes.slice(0, batchSize);
      const batchText =
        batchEpisodes.length === 1
          ? `第${batchEpisodes[0]}集`
          : batchEpisodes.every((episodeNo, index) => index === 0 || episodeNo === batchEpisodes[index - 1] + 1)
            ? `第${batchEpisodes[0]}-${batchEpisodes[batchEpisodes.length - 1]}集`
            : `第${batchEpisodes.join("、")}集`;
      const batchPrompt = [
        `生成剧本${batchText}，本批最多${batchEpisodes.length}集。`,
        "只写本批集数，不要写本批之外的剧本；正常完成后由系统自动推进下一批。",
        overwriteExisting ? "允许覆盖已有同集剧本。" : "已有同集剧本跳过，不重复生成。",
        prompt || "",
      ]
        .filter(Boolean)
        .join("\n");

      await runScriptAgent(batchPrompt);

      const episodeMapAfter = await getScriptEpisodeMap();
      const writtenEpisodes = batchEpisodes.filter((episodeNo) => episodeMapAfter.has(episodeNo));
      if (writtenEpisodes.length !== batchEpisodes.length) {
        const missingEpisodes = batchEpisodes.filter((episodeNo) => !episodeMapAfter.has(episodeNo));
        failed.push(`${batchText}未完整写入，缺失第${missingEpisodes.join("、")}集`);
        break;
      }
      completed.push(`${batchText}已写入`);
      for (const episodeNo of batchEpisodes) {
        processedEpisodes.add(episodeNo);
      }
    }

    if (failed.length) {
      return `剧本自动生成中止：${completed.join("；") || "尚无批次完成"}；${failed.join("；")}。`;
    }
    return `剧本自动生成到达安全批次数上限：${completed.join("；")}。请检查是否仍有缺失集数。`;
  }

  async function runScriptAgent(prompt: string) {
      const skill = path.join(u.getPath("skills"), "script_execution_script.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const scriptList = await u.db("o_script").where("projectId", resTool.data.projectId).select("id", "name");
      const scriptPrompt = ["## 可用剧本(ID:名称)", scriptList.map((s: any) => `${s.id}:${(s.name || "").replace(/[,:]/g, "")}`).join(","), ""].join(
        "\n",
      );

      const novelData = await u.db("o_novel").where("projectId", resTool.data.projectId).select("chapterIndex");

      const formatPrompt = `\n必须调用 set_script_item({ name, content, id? }) 逐集写入或更新剧本条目：本批有几集就调用几次，每次只写一集。不要先尝试用 set_script_items 一次性写入整批，避免大 JSON 参数解析失败。当前任务每次最多处理5集；如果任务范围超过5集，只处理明确指定的本批集数并拒绝扩写到批次外。禁止使用 <scriptItem> XML 输出作为主要写入方式，禁止只返回文字确认。`;

      return runAgent({
        key: "scriptAgent:scriptAgent",
        prompt,
        system: systemPrompt + formatPrompt,
        messages: [
          { role: "assistant", content: scriptPrompt + `章节数量：${novelData.length}章` },
          { role: "user", content: prompt + formatPrompt },
        ],
        name: "编剧",
        memoryKey: "assistant:execution:script",
      });
  }

  const run_supervision_agent = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "script_agent_supervision.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      return runAgent({
        key: "scriptAgent:supervisionAgent",
        prompt,
        system: systemPrompt,
        name: "编辑",
        memoryKey: "assistant:supervision",
      });
    },
  });

  return {
    run_sub_agent_storySkeleton,
    run_sub_agent_adaptationStrategy,
    run_sub_agent_script,
    run_sub_agent_script_auto,
    run_supervision_agent,
  };
}

async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  const completionToolResults: string[] = [];
  const completionToolNames = new Set([
    "set_story_skeleton",
    "append_story_skeleton_chunk",
    "set_adaptation_strategy",
    "set_script_item",
    "set_script_items",
    "run_sub_agent_storySkeleton",
    "run_sub_agent_adaptationStrategy",
    "run_sub_agent_script",
    "run_sub_agent_script_auto",
  ]);

  try {
    for await (const chunk of fullStream) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        text.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "tool-result" && completionToolNames.has(chunk.toolName)) {
        const result = chunk.result ?? chunk.output;
        const textResult = typeof result === "string" ? result : JSON.stringify(result);
        if (textResult?.trim()) {
          completionToolResults.push(textResult.trim());
        }
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    if (syncMsg) {
      const newMsg = syncMsg();
      if (newMsg !== msg) {
        msg = newMsg;
        text = msg.text();
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    thinking?.complete();
    if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
      text.complete();
      msg.stop();
      throw err;
    }
    const errMsg = err?.message ?? String(err);
    text.append(errMsg);
    text.error();
    msg.error();
    throw err;
  }

  return fullResponse.trim() ? fullResponse : completionToolResults.join("\n");
}

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}
