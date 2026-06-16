import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";

async function verifyToken(rawToken: string): Promise<Boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const { value: tokenKey } = setting;
  if (!rawToken) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, tokenKey as string);
    return true;
  } catch (err) {
    return false;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[productionAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    let isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[productionAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
      scriptId: socket.handshake.auth.scriptId,
    });
    let abortController: AbortController | null = null;
    type AgentMessage = ReturnType<ResTool["newMessage"]>;
    type ActiveRun = {
      controller: AbortController;
      rootMsg: AgentMessage;
      ctx: agent.AgentContext;
    };
    let activeRun: ActiveRun | null = null;

    const getRunMessages = (run: ActiveRun) => {
      const messages: AgentMessage[] = [run.rootMsg];
      if (run.ctx.msg.id !== run.rootMsg.id) messages.push(run.ctx.msg);
      return messages;
    };

    const settleRunMessages = (run: ActiveRun, status: "complete" | "stop" | "error", errorMsg?: string) => {
      for (const message of getRunMessages(run)) {
        if (status === "complete") message.complete();
        if (status === "stop") message.stop();
        if (status === "error") message.error(errorMsg);
      }
    };

    const abortActiveRun = (reason?: string) => {
      if (!activeRun) return;
      activeRun.controller.abort();
      settleRunMessages(activeRun, "stop");
      abortController = null;
      activeRun = null;
      if (reason) console.log(reason);
    };

    const isAbortError = (err: any, signal?: AbortSignal) => signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR";

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      abortActiveRun(`[productionAgent] 上下文切换，已中断当前生成: ${isolationKey}`);
      isolationKey = data.isolationKey;
      resTool = new ResTool(socket, {
        projectId: data.projectId,
        scriptId: data.scriptId,
      });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
      callback?.({ success: true });
    });

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortActiveRun("[productionAgent] 新请求，已中断上一轮生成");
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };
      const currentRun: ActiveRun = { controller: currentController, rootMsg: msg, ctx };
      activeRun = currentRun;
      let runSettled = false;

      try {
        await agent.runDecisionAI(ctx);
      } catch (err: any) {
        if (isAbortError(err, currentController.signal)) {
          settleRunMessages(currentRun, "stop");
          runSettled = true;
        } else {
          const errorMsg = u.error(err).message;
          console.error("[productionAgent] chat error:", errorMsg);
          settleRunMessages(currentRun, "error", errorMsg);
          runSettled = true;
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
        if (activeRun?.controller === currentController) {
          if (!runSettled) settleRunMessages(currentRun, currentController.signal.aborted ? "stop" : "complete");
          activeRun = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortActiveRun();
    });

    socket.on("disconnect", () => {
      abortActiveRun();
      console.log("[productionAgent] 已断开连接:", socket.id);
    });
  });
};
