import jwt from "jsonwebtoken";
import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
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
      console.log("[scriptAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    const isolationKey = socket.handshake.auth.isolationKey;
    if (!isolationKey) {
      console.log("[scriptAgent] 连接失败，缺少 isolationKey");
      socket.disconnect();
      return;
    }

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId: socket.handshake.auth.projectId,
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

    const abortActiveRun = () => {
      if (!activeRun) return;
      activeRun.controller.abort();
      settleRunMessages(activeRun, "stop");
      abortController = null;
      activeRun = null;
    };

    const isAbortError = (err: any, signal?: AbortSignal) => signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT_ERR";

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortActiveRun();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "统筹");
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
          console.error("[scriptAgent] chat error:", errorMsg);
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
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortActiveRun();
    });

    socket.on("disconnect", () => {
      abortActiveRun();
      console.log("[scriptAgent] 已断开连接:", socket.id);
    });
  });
};
