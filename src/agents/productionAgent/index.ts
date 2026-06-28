import { Socket } from "socket.io";
import { tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import Memory from "@/utils/agent/memory";
import { createSkillTools, parseFrontmatter, scanSkills, useSkill } from "@/utils/agent/skillsTools";
import useTools from "@/agents/productionAgent/tools";
import ResTool from "@/socket/resTool";
import * as fs from "fs";
import path from "path";

type RoleAssetRow = {
  id: number;
  name?: string | null;
  describe?: string | null;
  volcengineAssetUri?: string | null;
};

export interface AgentContext {
  socket: Socket;
  isolationKey: string;
  text: string;
  userMessageTime?: number;
  abortSignal?: AbortSignal;
  resTool: ResTool;
  msg: ReturnType<ResTool["newMessage"]>;
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  thinkConfig: {
    think: boolean;
    thinlLevel: 0 | 1 | 2 | 3;
  };
}

function inferDefaultRoleDerivative(role: RoleAssetRow, sourceText: string) {
  const text = `${role.name ?? ""}\n${role.describe ?? ""}\n${sourceText}`.toLowerCase();
  if (/校服|校园|学生|school|student/.test(text)) {
    return {
      name: "校服定装",
      describe: "区别于基础打底态 · 补全符合剧情常态的校服、发型与基础妆造，保持自然站立四视图",
    };
  }
  if (/职场|办公室|公司|商务|西装|职业|office|business|suit/.test(text)) {
    return {
      name: "职场定装",
      describe: "区别于基础打底态 · 补全现代职场服装、发型与基础妆造，保持自然站立四视图",
    };
  }
  if (/古|宫|仙|侠|王|侯|朝|袍|裙|盔甲|铠甲|hanfu|robe|armor/.test(text)) {
    return {
      name: "古装定装",
      describe: "区别于基础打底态 · 补全符合身份与剧情常态的古装服饰、发型与基础妆造，保持自然站立四视图",
    };
  }
  return {
    name: "常服定装",
    describe: "区别于基础打底态 · 补全符合剧情常态的完整服装、发型与基础妆造，保持自然站立四视图",
  };
}

async function emitAddDeriveAsset(socket: Socket, data: Record<string, any>) {
  await Promise.race([
    new Promise((resolve) => socket.emit("addDeriveAsset", data, (res: any) => resolve(res))),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function ensureDefaultRoleDerivatives(resTool: ResTool, socket: Socket, projectInfo: any) {
  const { projectId, scriptId } = resTool.data;
  if (!projectId || !scriptId) return "";

  const scriptData = await u.db("o_script").where({ id: scriptId }).select("content").first();
  const scriptAssets = await u.db("o_scriptAssets").where({ scriptId }).select("assetId");
  const parentAssetIds = scriptAssets.map((item: any) => Number(item.assetId)).filter((id) => Number.isInteger(id));
  if (!parentAssetIds.length) return "";

  const roleAssets: RoleAssetRow[] = await u
    .db("o_assets")
    .whereIn("id", parentAssetIds)
    .where({ projectId, type: "role" })
    .whereNull("assetsId")
    .select("id", "name", "describe", "volcengineAssetUri");
  if (!roleAssets.length) return "";

  const roleIds = roleAssets.map((item) => item.id);
  const childRows = await u.db("o_assets").whereIn("assetsId", roleIds).where({ type: "role" }).select("assetsId");
  const roleIdsWithDerive = new Set(childRows.map((item: any) => Number(item.assetsId)));
  const created: string[] = [];

  for (const role of roleAssets) {
    if (roleIdsWithDerive.has(role.id)) continue;

    const inferred = inferDefaultRoleDerivative(
      role,
      [scriptData?.content ?? "", projectInfo?.type ?? "", projectInfo?.directorManual ?? "", projectInfo?.artStyle ?? ""].join("\n"),
    );
    const startTime = Date.now();
    const data = {
      assetsId: role.id,
      projectId,
      name: inferred.name,
      type: "role",
      describe: inferred.describe,
      volcengineAssetUri: role.volcengineAssetUri ?? null,
      startTime,
    };
    const [insertedId] = await u.db("o_assets").insert(data);
    await u.db("o_scriptAssets").insert({ scriptId, assetId: insertedId });
    await emitAddDeriveAsset(socket, { ...data, id: insertedId });
    created.push(`${role.name ?? role.id}·${inferred.name}`);
  }

  if (!created.length) return "";
  return `\n系统兜底：已为缺少人物衍生的角色补全默认服装定装：${created.join("、")}。`;
}

function extractCompleteXmlTagContent(text: string, tag: string) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, "g");
  let match: RegExpExecArray | null;
  let lastValue: string | null = null;
  while ((match = regex.exec(text)) !== null) {
    lastValue = match[1]?.trim() ?? "";
  }
  return lastValue;
}

function isValidScriptPlanContent(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (text.length < 120) return false;
  return /分场汇总表|逐场注意事项|场间过渡|场次/.test(text);
}

async function persistScriptPlanToWorkspace(socket: Socket, resTool: ResTool, scriptPlan: string) {
  const projectId = Number(resTool.data.projectId);
  const scriptId = Number(resTool.data.scriptId);
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) return;

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
    const scriptData = await u.db("o_script").where({ id: scriptId, projectId }).select("content").first();
    data.script = scriptData?.content ?? "";
  }
  if (!Array.isArray(data.storyboard)) data.storyboard = [];
  if (!data.workbench) data.workbench = { videoList: [] };
  data.scriptPlan = scriptPlan;

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

  await Promise.race([
    new Promise((resolve) =>
      socket.emit(
        "setScriptPlan",
        {
          projectId,
          scriptId,
          scriptPlan,
          length: scriptPlan.length,
        },
        (res: any) => resolve(res),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
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
  return `## Memory\n以下是你对用户的记忆，可作为参考但不要主动提及：\n${memoryContext}`;
}

export async function runDecisionAI(ctx: AgentContext) {
  const { isolationKey, text, abortSignal } = ctx;
  const memory = new Memory("productionAgent", isolationKey);
  await memory.add("user", text);

  const skill = path.join(u.getPath("skills"), "production_agent_decision.md");
  const prompt = await fs.promises.readFile(skill, "utf-8");

  const projectInfo = await u.db("o_project").where("id", ctx.resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${ctx.resTool.data.projectId}`);
  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;
  // console.log("%c Line:64 🍯 isRef", "background:#b03734", isRef);
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  // const isRef = findData.mode.every((i: any) => Array.isArray(i));
  console.log("%c Line:67 🍪 isRef", "background:#fca650", isRef);
  const videoModeText = Array.isArray(videoMode) ? JSON.stringify(videoMode) : String(videoMode || "未配置");
  const modelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n视频模式：${videoModeText}\n多参：${isRef ? "是" : "否"}\n阶段5分镜面板模式：调用 set_storyboard_panel_from_table({ mode: "auto", startNo, endNo }) 分段写入，每批最多10条；工具自动选择 text/imageReference/singleImage`;

  const mem = buildMemPrompt(await memory.get(text));

  const { fullStream } = await u.Ai.Text("productionAgent:decisionAgent", ctx.thinkConfig.think, ctx.thinkConfig.thinlLevel).stream({
    messages: [
      { role: "system", content: prompt },
      { role: "assistant", content: mem + "\n" + modelInfo },
      { role: "user", content: text },
    ],
    abortSignal,
    tools: {
      ...memory.getTools(),
      ...useTools({ resTool: ctx.resTool, msg: ctx.msg }),
      ...(await createSubAgent(ctx)),
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

async function createSubAgent(parentCtx: AgentContext) {
  const { resTool, abortSignal } = parentCtx;
  const memory = new Memory("productionAgent", parentCtx.isolationKey);
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

    const { fullStream } = await u.Ai.Text(key, parentCtx.thinkConfig.think, parentCtx.thinkConfig.thinlLevel).stream({
      system,
      messages: messages ?? [{ role: "user", content: prompt }],
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

  const projectInfo = await u.db("o_project").where("id", resTool.data.projectId).first();
  if (!projectInfo) throw new Error(`项目不存在，ID: ${resTool.data.projectId}`);
  const artSkills = await createArtSkills(projectInfo?.artStyle!, projectInfo?.directorManual!);

  const [_, imageModelName] = projectInfo.imageModel!.split(/:(.+)/);
  const [id, videoModelName] = projectInfo.videoModel!.split(/:(.+)/);
  const models = await u.vendor.getModelList(id);
  if (!models.length) throw new Error(`项目使用的模型不存在，ID: ${projectInfo.videoModel}`);
  // const findData = models.find((i: any) => i.modelName == videoModelName);
  // console.log("%c Line:153 🍿 findData.mode", "background:#93c0a4", findData.mode);
  let videoMode = "";
  try {
    videoMode = JSON.parse(projectInfo.mode ?? "");
  } catch (e) {
    videoMode = projectInfo.mode ?? "";
  }
  const isRef = Array.isArray(videoMode) ? true : false;
  console.log("%c Line:153 🥤 isRef", "background:#42b983", isRef);
  const videoModeText = Array.isArray(videoMode) ? JSON.stringify(videoMode) : String(videoMode || "未配置");
  const modelInfo = `项目使用的模型如下：\n图像模型：${imageModelName}\n视频模型：${videoModelName}\n视频模式：${videoModeText}\n多参：${isRef ? "是" : "否"}\n阶段5分镜面板模式：调用 set_storyboard_panel_from_table({ mode: "auto", startNo, endNo }) 分段写入，每批最多10条；工具自动选择 text/imageReference/singleImage`;
  const isSuccessfulStoryboardTableResult = (result: string) => {
    const text = String(result || "");
    if (!text.trim()) return false;
    if (/(未通过校验|生成失败|写入失败|已过期|缺少|无法|错误|REWORK|AUTO_FIX|NEED_USER)/i.test(text)) return false;
    return /(阶段4已完成|分镜表生成完成|分镜表写入完成|已由\s*shotPlan\s*生成分镜表|自动渲染生成标准\s*13\s*列分镜表)/i.test(text);
  };
  const countStoryboardTableRows = (content: unknown) => {
    return String(content ?? "")
      .split(/\r?\n/)
      .filter((line) => /^\|\s*\d+\s*\|/.test(line.trim())).length;
  };
  const getProductionWorkDataSnapshot = async () => {
    const row = await u
      .db("o_agentWorkData")
      .where("projectId", String(resTool.data.projectId))
      .where("episodesId", String(resTool.data.scriptId))
      .where("key", "productionAgent")
      .first();

    let data: Record<string, any> = {};
    if (row?.data) {
      try {
        data = JSON.parse(row.data);
      } catch {
        data = {};
      }
    }

    const shotPlanShots = Array.isArray(data?.shotPlan?.shots) ? data.shotPlan.shots.length : 0;
    const draftShots = Array.isArray(data?.shotPlanDraft?.shots) ? data.shotPlanDraft.shots.length : 0;
    const draftBeats = Array.isArray(data?.shotPlanDraft?.beats) ? data.shotPlanDraft.beats.length : 0;
    const storyboardTableRows = countStoryboardTableRows(data?.storyboardTable);

    return {
      hasRow: Boolean(row),
      shotPlanShots,
      draftShots,
      draftBeats,
      storyboardTableRows,
    };
  };
  const formatStage4State = (state: Awaited<ReturnType<typeof getProductionWorkDataSnapshot>>) => {
    return `正式 shotPlan.shots=${state.shotPlanShots}，storyboardTable 行数=${state.storyboardTableRows}，草稿 beats=${state.draftBeats}，草稿 shots=${state.draftShots}`;
  };
  const ensureStoryboardTablePersisted = async (nextStage: string) => {
    const state = await getProductionWorkDataSnapshot();
    if (state.shotPlanShots > 0 && state.storyboardTableRows > 0) return "";
    return `已拦截：${nextStage} 前置条件未满足，阶段4分镜表未真实落库（${formatStage4State(state)}）。必须重新执行阶段4：start_shot_plan 写入 beats，append_shot_plan_shots 分批写入正式 shots（最后一批 isFinal=true），再调用 render_storyboard_table_from_shot_plan。禁止继续进入阶段5/6。`;
  };
  const getStoryboardPanelSnapshot = async () => {
    const [storyboardCountRow, videoTrackCountRow] = await Promise.all([
      u
        .db("o_storyboard")
        .where("projectId", String(resTool.data.projectId))
        .where("scriptId", String(resTool.data.scriptId))
        .count({ count: "*" })
        .first(),
      u
        .db("o_videoTrack")
        .where("projectId", String(resTool.data.projectId))
        .where("scriptId", String(resTool.data.scriptId))
        .count({ count: "*" })
        .first(),
    ]);
    const readCount = (row: any) => Number(row?.count ?? row?.["count(*)"] ?? 0);
    return {
      storyboardCount: readCount(storyboardCountRow),
      videoTrackCount: readCount(videoTrackCountRow),
    };
  };
  const ensureStoryboardPanelPersisted = async (nextStage: string) => {
    const state = await getStoryboardPanelSnapshot();
    if (state.storyboardCount > 0) return "";
    return `已拦截：${nextStage} 前置条件未满足，分镜面板未真实落库（o_storyboard=${state.storyboardCount}，o_videoTrack=${state.videoTrackCount}）。必须先重新执行阶段5：按每批最多10条调用 set_storyboard_panel_from_table({ mode:"auto", startNo, endNo })，并确认 get_flowData("storyboard") 返回非空。禁止继续进入阶段6。`;
  };
  const runSupervisionAgent = async (prompt: string) => {
    const skill = path.join(u.getPath("skills"), "production_agent_supervision.md");
    const systemPrompt = await fs.promises.readFile(skill, "utf-8");
    return runAgent({
      key: "productionAgent:supervisionAgent",
      prompt,
      system: systemPrompt,
      name: "监制",
      memoryKey: "assistant:supervision",
    });
  };

  //衍生资产分析与信息写入
  const run_sub_agent_derive_assets = tool({
    description: "运行执行subAgent来完成衍生资产分析与信息写入相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_derive_assets.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const result = await runAgent({
        key: "productionAgent:deriveAssetsAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
      const fallbackResult = await ensureDefaultRoleDerivatives(resTool, parentCtx.socket, projectInfo);
      return `${result}${fallbackResult}`;
    },
  });

  //衍生资产图片生成
  const run_sub_agent_generate_assets = tool({
    description: "运行执行subAgent来完成衍生资产图片生成相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_generate_assets.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      const fallbackResult = await ensureDefaultRoleDerivatives(resTool, parentCtx.socket, projectInfo);
      const promptWithFallback = fallbackResult ? `${prompt}\n${fallbackResult}` : prompt;
      const result = await runAgent({
        key: "productionAgent:generateAssetsAgent",
        prompt: promptWithFallback,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: promptWithFallback },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
      return `${fallbackResult}${result}`;
    },
  });

  //拍摄计划
  const run_sub_agent_director_plan = tool({
    description: "运行执行subAgent来完成导演规划相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_director_plan.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt =
        '\n阶段1导演计划必须通过工具写入：调用 set_script_plan({ content }) 写入完整导演计划正文。禁止使用 <scriptPlan> XML 输出作为主要写入方式；写入后用 get_flowData("scriptPlan") 确认内容已保存。';

      const result = await runAgent({
        key: "productionAgent:directorPlanAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + addPrompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
      const scriptPlan = extractCompleteXmlTagContent(result, "scriptPlan");
      if (isValidScriptPlanContent(scriptPlan)) {
        await persistScriptPlanToWorkspace(parentCtx.socket, resTool, scriptPlan!.trim());
      } else if (!/导演计划写入完成|set_script_plan/i.test(result)) {
        console.warn("[productionAgent] 未检测到有效 scriptPlan XML，跳过导演计划持久化", {
          projectId: resTool.data.projectId,
          scriptId: resTool.data.scriptId,
          resultLength: result.length,
        });
      }
      return result;
    },
  });

  //分镜图生成
  const run_sub_agent_storyboard_gen = tool({
    description: "运行执行subAgent来完成分镜图生成相关任务。若用户语境是故事板先行，禁止调用本工具。",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      if (/(故事板先行|先出故事板|从剧本生成故事板图片|故事板转视频|单图故事板)/.test(`${parentCtx.text}\n${prompt}`)) {
        return "已拦截：当前是故事板先行语境，应使用故事板先行工具，不调用分镜图生成子 Agent。";
      }
      const blockReason = await ensureStoryboardPanelPersisted("阶段6");
      if (blockReason) return blockReason;
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_gen.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");
      return runAgent({
        key: "productionAgent:storyboardGenAgent",
        prompt,
        system: systemPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: artSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt },
        ],
        tools: { activate_skill: artSkills.tools.activate_skill },
      });
    },
  });

  // const mainSkills: { path: string; name: string; description: string }[] = [];
  // for (const skill of mainSkill) {
  //   const skillPath = path.join(rootDir, skill + ".md");
  //   if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
  //   if (!isPathInside(skillPath, normalizedRootDir)) throw new Error(`技能名称无效：检测到路径穿越。${skillPath}`);
  //   const content = await fs.promises.readFile(skillPath, "utf-8");
  //   const parsed = parseFrontmatter(content);
  //   mainSkills.push({ path: skillPath, ...parsed });
  // }

  const productionSkills = await useProductionSkills(projectInfo?.artStyle!, projectInfo?.directorManual!);

  //分镜面板写入
  const run_sub_agent_storyboard_panel = tool({
    description: "运行执行subAgent来完成分镜面板写入相关任务。若用户语境是故事板先行，禁止调用本工具。",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      if (/(故事板先行|先出故事板|从剧本生成故事板图片|故事板转视频|单图故事板)/.test(`${parentCtx.text}\n${prompt}`)) {
        return "已拦截：当前是故事板先行语境，应使用故事板先行工具，不调用分镜面板子 Agent。";
      }
      const stage4BlockReason = await ensureStoryboardTablePersisted("阶段5");
      if (stage4BlockReason) return stage4BlockReason;
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_panel.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt =
        "\n分镜面板写入只有一个入口：set_storyboard_panel_from_table。调用时必须传 mode:\"auto\"，由工具根据项目视频模型自动选择 text/imageReference/singleImage。必须按 startNo/endNo 分段写入，每批最多10条；即使面板为空的首次写入，也禁止一次写入全部分镜。完整重写时先调用 clear_storyboard_panel，再按 1-10、11-20、21-30 这种范围连续调用 set_storyboard_panel_from_table({ mode:\"auto\", startNo, endNo })；补齐缺失时也按缺失序号分批调用。不要使用 replaceAll 做全量写入。不要输出可被解析为写入内容的文本，不要只返回文字确认。每批写入后读取 get_flowData(\"storyboard\") 确认真正落库数量，全部批次完成后再次确认总数。";

      const executionResult = await runAgent({
        key: "productionAgent:storyboardPanelAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + addPrompt },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
      const panelBlockReason = await ensureStoryboardPanelPersisted("阶段6");
      if (panelBlockReason) return `${executionResult}\n\n[落库校验]\n${panelBlockReason}`;
      return executionResult;
    },
  });

  //分镜表写入
  const run_sub_agent_storyboard_table = tool({
    description: "运行执行subAgent来完成分镜表构建相关任务",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      const skill = path.join(u.getPath("skills"), "production_execution_storyboard_table.md");
      const systemPrompt = await fs.promises.readFile(skill, "utf-8");

      const addPrompt =
        "\n阶段4必须走分块主工具链：先调用 start_shot_plan 写入 beats，再用 append_shot_plan_shots 按 shotNo 顺序分批追加 shots（每批 8-12 个，最后一批 isFinal=true），最后调用 render_storyboard_table_from_shot_plan 自动生成标准 13 列分镜表。小于 12 个镜头的小项目才可使用 set_shot_plan 一次性写入。不要只输出文本草案或分析。";

      const executionResult = await runAgent({
        key: "productionAgent:storyboardTableAgent",
        prompt,
        system: systemPrompt + addPrompt,
        name: "执行导演",
        memoryKey: "assistant:execution",
        messages: [
          { role: "assistant", content: productionSkills.prompt + `\n${modelInfo}` },
          { role: "user", content: prompt + addPrompt },
        ],
        tools: { activate_skill: productionSkills.tools.activate_skill },
      });
      if (!isSuccessfulStoryboardTableResult(executionResult)) return executionResult;
      const stage4BlockReason = await ensureStoryboardTablePersisted("阶段5/6");
      if (stage4BlockReason) return `${executionResult}\n\n[落库校验]\n${stage4BlockReason}`;

      const supervisionResult = await runSupervisionAgent("请审核【阶段4：构建分镜表】产出物，重点检查结构、时长、台词覆盖、资产关联。");
      return `${executionResult}\n\n[自动监督审核]\n${supervisionResult}`;
    },
  });

  const run_sub_agent_supervision = tool({
    description: "运行监督层subAgent执行独立任务，完成后返回结果",
    inputSchema: promptInput,
    execute: async ({ prompt }) => {
      return runSupervisionAgent(prompt);
    },
  });

  return {
    run_sub_agent_derive_assets,
    run_sub_agent_generate_assets,
    run_sub_agent_director_plan,
    run_sub_agent_storyboard_gen,
    run_sub_agent_storyboard_panel,
    run_sub_agent_storyboard_table,
    run_sub_agent_supervision,
  };
}

async function createArtSkills(artName: string, storyName: string) {
  const artWorkerPath = u.getPath(["skills", "art_skills", artName, "driector_skills"]);
  const storyWorkerPath = u.getPath(["skills", "story_skills", storyName, "driector_skills"]);
  const skillList = [...(await scanSkills(artWorkerPath + "/*.md")), ...(await scanSkills(storyWorkerPath + "/*.md"))];
  const mainSkills: { path: string; name: string; description: string }[] = [];
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  const res = {
    prompt: `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }),
  };
  return res;
}
async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  initialMsg: ReturnType<ResTool["newMessage"]>,
  syncMsg?: () => ReturnType<ResTool["newMessage"]>,
): Promise<string> {
  let msg = initialMsg;
  let text = msg.text();
  let thinking: ReturnType<typeof msg.thinking> | null = null;
  let progressThinking: ReturnType<typeof msg.thinking> | null = null;
  let thinkTime = 0;
  let fullResponse = "";
  let activeToolName = "";
  let activeToolInputChars = 0;
  let stepCount = 0;
  let lastVisibleUpdate = Date.now();
  let lastToolInputUpdate = 0;

  const toolLabels: Record<string, string> = {
    activate_skill: "加载技能",
    get_flowData: "获取工作区数据",
    set_script_plan: "写入导演计划",
    start_shot_plan: "开始镜头规划分块",
    append_shot_plan_shots: "追加镜头规划分块",
    set_shot_plan: "写入镜头规划",
    render_storyboard_table_from_shot_plan: "生成分镜表",
    set_storyboard_table: "写入分镜表",
    clear_storyboard_panel: "清空分镜面板",
    set_storyboard_panel_from_table: "写入分镜面板",
    generate_storyboard_images: "生成分镜图片",
  };

  const getToolLabel = (toolName?: string) => {
    if (!toolName) return "后台任务";
    return toolLabels[toolName] ?? toolName;
  };

  const touchVisibleUpdate = () => {
    lastVisibleUpdate = Date.now();
  };

  const ensureProgressThinking = (title: string) => {
    if (!progressThinking) {
      progressThinking = msg.thinking(title);
    } else {
      progressThinking.updateTitle(title);
    }
    return progressThinking;
  };

  const appendProgress = (title: string, line: string) => {
    const stream = ensureProgressThinking(title);
    stream.appendText(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${line}\n`);
    touchVisibleUpdate();
  };

  const completeProgressThinking = () => {
    if (!progressThinking) return;
    progressThinking.complete();
    progressThinking = null;
  };

  const heartbeat = setInterval(() => {
    if (Date.now() - lastVisibleUpdate < 15000) return;
    const title = activeToolName ? `正在执行：${getToolLabel(activeToolName)}` : "执行导演仍在处理...";
    const detail = activeToolName
      ? `后台仍在执行 ${getToolLabel(activeToolName)}，请等待结果返回。`
      : "后台仍在处理模型输出或工具调用，尚未返回新的流式内容。";
    appendProgress(title, detail);
  }, 15000);

  try {
    for await (const chunk of fullStream) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
      if (syncMsg) {
        const newMsg = syncMsg();
        if (newMsg !== msg) {
          completeProgressThinking();
          msg = newMsg;
          text = msg.text();
        }
      }
      if (chunk.type === "reasoning-start") {
        completeProgressThinking();
        thinkTime = Date.now();
        thinking = msg.thinking("思考中...");
        touchVisibleUpdate();
      } else if (chunk.type === "reasoning-delta") {
        thinking?.append(chunk.text);
        touchVisibleUpdate();
      } else if (chunk.type === "reasoning-end") {
        thinkTime = Date.now() - thinkTime;
        thinking?.updateTitle(`思考完毕（${(thinkTime / 1000).toFixed(1)} 秒）`);
        thinking?.complete();
        thinking = null;
        touchVisibleUpdate();
      } else if (chunk.type === "text-delta") {
        completeProgressThinking();
        text.append(chunk.text);
        fullResponse += chunk.text;
        touchVisibleUpdate();
      } else if (chunk.type === "start-step") {
        stepCount += 1;
        appendProgress(`执行导演正在处理第 ${stepCount} 轮`, `开始第 ${stepCount} 轮模型推理。`);
      } else if (chunk.type === "tool-input-start") {
        activeToolName = chunk.toolName || activeToolName;
        activeToolInputChars = 0;
        lastToolInputUpdate = Date.now();
        appendProgress(`正在准备：${getToolLabel(activeToolName)}`, `开始准备 ${getToolLabel(activeToolName)} 的调用参数。`);
      } else if (chunk.type === "tool-input-delta") {
        activeToolInputChars += String(chunk.delta || "").length;
        if (Date.now() - lastToolInputUpdate > 5000) {
          lastToolInputUpdate = Date.now();
          appendProgress(
            `正在准备：${getToolLabel(activeToolName)}`,
            `正在组织 ${getToolLabel(activeToolName)} 的参数，已生成约 ${activeToolInputChars} 字符。`,
          );
        }
      } else if (chunk.type === "tool-input-end") {
        appendProgress(`正在准备：${getToolLabel(activeToolName)}`, `${getToolLabel(activeToolName)} 参数准备完成，等待执行。`);
      } else if (chunk.type === "tool-call") {
        activeToolName = chunk.toolName || activeToolName;
        appendProgress(`正在执行：${getToolLabel(activeToolName)}`, `已发起 ${getToolLabel(activeToolName)}。`);
      } else if (chunk.type === "tool-result") {
        const toolName = chunk.toolName || activeToolName;
        appendProgress(`已完成：${getToolLabel(toolName)}`, `${getToolLabel(toolName)} 已返回结果。`);
        activeToolName = "";
        activeToolInputChars = 0;
      } else if (chunk.type === "tool-error") {
        const toolName = chunk.toolName || activeToolName;
        appendProgress(`执行失败：${getToolLabel(toolName)}`, `${getToolLabel(toolName)} 返回错误：${chunk.error ?? "未知错误"}`);
        activeToolName = "";
        activeToolInputChars = 0;
      } else if (chunk.type === "finish-step") {
        appendProgress(`执行导演完成第 ${stepCount} 轮`, `第 ${stepCount} 轮处理完成，原因：${chunk.finishReason ?? "unknown"}。`);
      } else if (chunk.type === "abort") {
        throw Object.assign(new Error(chunk.reason || "生成已停止"), { name: "AbortError" });
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    clearInterval(heartbeat);
    completeProgressThinking();
    if (syncMsg) {
      const newMsg = syncMsg();
      if (newMsg !== msg) {
        completeProgressThinking();
        msg = newMsg;
        text = msg.text();
      }
    }
    text.complete();
    msg.complete();
  } catch (err: any) {
    clearInterval(heartbeat);
    completeProgressThinking();
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

  return fullResponse;
}
function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

export function buildSkillPrompt(skills: { name: string; description: string }[]): string {
  const skillEntries = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`)
    .join("\n");
  return `
<available_skills>
${skillEntries}
</available_skills>`;
}

async function useProductionSkills(artName: string, storyName: string) {
  const artWorkerPath = u.getPath(["skills", "art_skills", artName, "driector_skills"]);
  const storyWorkerPath = u.getPath(["skills", "story_skills", storyName, "driector_skills"]);
  const productionPath = u.getPath(["skills", "production_skills"]);
  const skillList = [
    ...(await scanSkills(artWorkerPath + "/*.md")),
    ...(await scanSkills(storyWorkerPath + "/*.md")),
    ...(await scanSkills(productionPath + "/*.md")),
  ];
  const mainSkills: { path: string; name: string; description: string }[] = [];
  for (const skillPath of skillList) {
    if (!fs.existsSync(skillPath)) throw new Error(`主技能文件不存在: ${skillPath}`);
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
  }
  const res = {
    prompt: `## Skills
以下技能提供了专业任务的专用指令。
当任务与某个技能的描述匹配时，调用 activate_skill 工具并传入技能名称来加载完整指令。
${buildSkillPrompt(mainSkills)}`,
    tools: createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills: [], tertiarySkills: [] }),
  };
  return res;
}
