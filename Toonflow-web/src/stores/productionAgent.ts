import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";
import type { FlowData, Storyboard } from "@/views/production/utils/flowBuilder";
import { appendCacheBust, getVersionedPreviewImageSrc } from "@/views/production/utils/imagePreview";
import type { ChatMessagesData } from "@tdesign-vue-next/chat";
import { useThrottleFn } from "@vueuse/core";

function applyImageState(target: { src?: string | null; thumbSrc?: string | null }, src?: string | null, thumbSrc?: string | null, version = Date.now()) {
  target.src = src ? appendCacheBust(src, version) : null;
  target.thumbSrc = src || thumbSrc ? getVersionedPreviewImageSrc(thumbSrc, src, { width: 480, format: "webp" }, version) : null;
}

function parseShouldGenerateImage(value: unknown) {
  if (value == null || value === "") return 1;
  if (typeof value === "boolean") return value ? 1 : 0;

  const normalized = String(value).trim().toLowerCase();
  if (["false", "0", "no", "n", "否", "不", "不生成", "skip"].includes(normalized)) return 0;
  return 1;
}

function parseAssociateAssetsIds(value: unknown) {
  if (Array.isArray(value)) return value.map(Number).filter((id) => Number.isInteger(id));
  if (value == null || value === "") return [];

  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((id) => Number.isInteger(id));
  } catch {
    return [];
  }
}

function makeProductionAgentStore(projectId: string) {
  return defineStore(`productionAgent-${projectId}`, () => {
    const defMsg: ChatMessagesData[] = [
      {
        id: "welcome",
        role: "assistant",
        content: [
          { type: "text", status: "complete", data: $t("workbench.production.chatBox.welcomeMessage") },
          {
            type: "suggestion",
            status: "complete",
            data: [
              { title: $t("workbench.production.chatBox.startMakingVideo"), prompt: $t("workbench.production.chatBox.startMakingVideoPrompt") },
            ],
          },
        ],
      },
    ];
    onMounted(() => {
      if (messages.value.length <= 0) messages.value = [...defMsg, ...messages.value];
    });

    const flowData = ref<FlowData>({
      script: "", // 剧本
      scriptPlan: "", //导演计划
      shotPlan: null,
      shotPolicy: null,
      targetDuration: null,
      targetDurationSource: null,
      scriptTargetDuration: null,
      scriptTargetDurationSource: null,
      scriptTargetDurationRaw: null,
      storyboardTable: "", //分镜表
      assets: [], // 衍生资产
      storyboard: [], //分镜面板
      workbench: {
        name: "",
        duration: "",
        resolution: "",
        fps: "",
        videoList: [],
      }, // 工作台数据
    });

    const episodesId = ref<number>();

    const { connected, messages, chat, stopGenerate, socket, status, currentMessageId, reconnect, connect, disconnect } = useChat({
      url: `${settingStore().baseUrl}/socket/productionAgent`,
      auth: () => ({
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      }),
      manageLifecycle: false,
      autoConnect: false,
      xmlTags: [
        { tag: "script", keepInMessage: false },
        { tag: "scriptPlan", keepInMessage: false },
        { tag: "storyboardTable", keepInMessage: false },
        { tag: "storyboardItem", keepInMessage: false },
      ],
      onXmlTag: async (data) => {
        const { tag, value, children, attrs, status } = data;
        if (tag === "script") {
          flowData.value.script = value ?? "";
        } else if (tag === "scriptPlan") {
          flowData.value.scriptPlan = value ?? "";
        } else if (tag === "storyboardTable") {
          flowData.value.storyboardTable = value ?? "";
        } else if (tag === "storyboardItem") {
          if (status === "complete") {
            const prompt = attrs.prompt ?? "";
            const duration = Number(attrs.duration) || 0;
            const track = attrs.track || "";
            const shouldGenerateImage = parseShouldGenerateImage(attrs.shouldGenerateImage);
            const videoDesc = attrs?.videoDesc ?? "";
            const associateAssetsIds = parseAssociateAssetsIds(attrs.associateAssetsIds);
            const existingIndex = flowData.value.storyboard.findIndex(
              (s) => s.prompt == prompt && s.duration == duration && videoDesc == s.videoDesc,
            );
            if (existingIndex !== -1) {
              // 已存在则更新 content，保留 id
              flowData.value.storyboard[existingIndex].prompt = prompt;
            } else {
              // 不存在则追加新条目
              flowData.value.storyboard.push({
                prompt: prompt || "",
                duration: Number(duration) || 0,
                state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
                src: null,
                associateAssetsIds,
                videoDesc: videoDesc,
                shouldGenerateImage: shouldGenerateImage,
              });
              try {
                await addStoryboardInfo([
                  {
                    prompt: prompt || "",
                    duration: Number(duration) || 0,
                    track: track || "",
                    state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
                    src: null,
                    videoDesc,
                    shouldGenerateImage,
                    associateAssetsIds,
                  },
                ]);
              } catch (e) {
                console.error("[storyboard.addStoryboardInfo] sync failed", e);
                await getFlowData();
              }
            }
          }
        }
        if (status == "complete") {
          throttledFn();
        }
      },
    });

    // 实际的节流方法
    const throttledFn = useThrottleFn(
      () => {
        setFlowData(episodesId.value);
      },
      500,
      true,
      true,
    );
    // 注册 getPlanData 事件（无需依赖组件生命周期）
    watch(
      socket,
      (s) => {
        if (s) {
          s.on("connect", () => {
            getHistory({ onlyWhenEmpty: true });
          });
          s.on("getFlowData", async ({ key }, callback) => {
            try {
              if (key === "storyboard" && flowData.value.storyboard.some((item) => item.shouldGenerateImage && !item.id)) {
                await getFlowData();
              }
              const returnData = JSON.parse(JSON.stringify(flowData.value));
              returnData.assets.forEach((item: any) => {
                delete item.prompt;
                delete item.flowId;
                delete item.src;
                if (item.derive && item.derive.length) {
                  item.derive.forEach((deriveItem: any) => {
                    delete deriveItem.prompt;
                    delete deriveItem.flowId;
                    delete deriveItem.src;
                  });
                }
              });
              returnData.storyboard.forEach((item: any) => {
                delete item.prompt;
                delete item.src;
                delete item.flowId;
              });
              callback?.(returnData);
            } catch (error) {
              console.error("[productionAgent] getFlowData callback failed", error);
              callback?.({
                ...flowData.value,
                __error: error instanceof Error ? error.message : String(error),
              });
            }
          });
          s.on("addDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const item = deriveAssetList.find((d) => d.id === data.id);
            if (item) {
              if (!item) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
              item.name = data.name;
              item.type = assets.type;
              callback({ success: true, message: $t("storyboard.assets.derivativeUpdateSuccess") });
            } else {
              deriveAssetList.push({
                assetsId: data.assetsId,
                id: data.id,
                name: data.name,
                type: assets.type,
                desc: data.describe,
                prompt: "",
                state: "未生成" as "未生成" | "生成中" | "已完成" | "生成失败",
                src: "",
                thumbSrc: "",
              });
              callback({ success: true, message: $t("storyboard.assets.derivativeAddSuccess") });
            }
          });
          s.on("delDeriveAsset", async (data, callback) => {
            const assets = flowData.value.assets.find((a) => a.id === data.assetsId);
            if (!assets) return callback({ success: false, message: $t("storyboard.assets.notExist") });
            const deriveAssetList = assets.derive || [];
            const index = deriveAssetList.findIndex((d) => d.id === data.id);
            if (index === -1) return callback({ success: false, message: $t("storyboard.assets.notDerivativeExist") });
            deriveAssetList.splice(index, 1);
            callback({ success: true, message: $t("storyboard.assets.derivativeDelSuccess") });
          });
          s.on("generateDeriveAsset", async (data, callback) => {
            const assetsData = await batchGenerateAssets(data.ids);
            callback({ success: true, message: assetsData });
          });
          s.on("generateStoryboard", async (data, callback) => {
            const storyData = await batchGenerateStoryboard(data.ids, {
              usePreviousVideoTailFrame: Boolean(data?.usePreviousVideoTailFrame),
            });
            callback({ success: true, message: storyData });
          });
          s.on("clearStoryboardPanel", async (data, callback) => {
            flowData.value.storyboard = [];
            stopStoryboardPolling();
            callback?.({
              success: true,
              message: `已清空分镜 ${data?.storyboardCount ?? 0} 条`,
            });
          });
          s.on("setStoryboardTable", async (data, callback) => {
            flowData.value.storyboardTable = data?.storyboardTable ?? "";
            callback?.({
              success: true,
              message: `已写入分镜表 ${data?.rowCount ?? 0} 行`,
            });
          });
          s.on("setScriptPlan", async (data, callback) => {
            const targetEpisodesId = Number(data?.scriptId);
            const currentEpisodesId = Number(episodesId.value);
            if (!Number.isFinite(targetEpisodesId) || targetEpisodesId !== currentEpisodesId) {
              callback?.({
                success: false,
                message: `前端当前剧集 ${currentEpisodesId || "-"} 与写入剧集 ${targetEpisodesId || "-"} 不一致，未刷新导演计划`,
              });
              return;
            }
            flowData.value.scriptPlan = data?.scriptPlan ?? "";
            callback?.({
              success: true,
              message: `已写入导演计划 ${String(data?.scriptPlan ?? "").length} 字`,
            });
          });
          s.on("setShotPlan", async (data, callback) => {
            flowData.value.shotPlan = data?.shotPlan ?? null;
            flowData.value.targetDuration = Number.isFinite(Number(data?.targetDuration)) ? Number(data.targetDuration) : null;
            flowData.value.targetDurationSource = data?.targetDurationSource ?? data?.shotPlan?.targetDurationSource ?? null;
            flowData.value.scriptTargetDuration = data?.scriptTargetDuration ?? flowData.value.scriptTargetDuration ?? null;
            flowData.value.scriptTargetDurationSource = data?.scriptTargetDurationSource ?? flowData.value.scriptTargetDurationSource ?? null;
            flowData.value.scriptTargetDurationRaw = data?.scriptTargetDurationRaw ?? flowData.value.scriptTargetDurationRaw ?? null;
            callback?.({
              success: true,
              message: `已写入镜头规划 ${data?.shotCount ?? 0} 个镜头`,
            });
          });
          s.on("setStoryboardPanel", async (data, callback) => {
            const targetEpisodesId = Number(data?.scriptId);
            const currentEpisodesId = Number(episodesId.value);
            if (!Number.isFinite(targetEpisodesId) || targetEpisodesId !== currentEpisodesId) {
              callback?.({
                success: false,
                message: `前端当前剧集 ${currentEpisodesId || "-"} 与写入剧集 ${targetEpisodesId || "-"} 不一致，未刷新分镜面板`,
                storyboardCount: flowData.value.storyboard.length,
              });
              return;
            }
            const latestFlowData = await getFlowData(targetEpisodesId);
            const storyboardCount = latestFlowData?.storyboard?.length ?? flowData.value.storyboard.length;
            callback?.({
              success: storyboardCount > 0,
              message: storyboardCount > 0 ? `已刷新分镜面板 ${storyboardCount} 条` : "分镜面板刷新后仍为空",
              storyboardCount,
            });
          });
        }
      },
      { immediate: true },
    );

    async function setFlowData(scriptId?: number) {
      await axios.post("/production/saveFlowData", {
        projectId: projectId,
        data: flowData.value,
        episodesId: scriptId || episodesId.value,
      });
    }

    async function getFlowData(targetEpisodesId = episodesId.value) {
      const { data } = await axios.post("/production/getFlowData", {
        projectId: projectId,
        episodesId: targetEpisodesId,
      });
      flowData.value = data;
      return data;
    }
    async function batchGenerateStoryboard(allIds: number[], options: { usePreviousVideoTailFrame?: boolean } = {}) {
      const uniqueIds = Array.from(new Set(allIds.filter((id): id is number => Number.isInteger(id))));
      if (!uniqueIds.length) return [];
      flowData.value.storyboard.forEach((item) => {
        if (item.id && uniqueIds.includes(item.id)) {
          item.state = "生成中" as "未生成" | "生成中" | "已完成" | "生成失败";
          item.src = null;
          item.thumbSrc = null;
          item.reason = "";
        }
      });
      const { data } = await axios.post("/production/storyboard/batchGenerateImage", {
        scriptId: episodesId.value,
        projectId: projectId,
        storyboardIds: uniqueIds,
        concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
        usePreviousVideoTailFrame: Boolean(options.usePreviousVideoTailFrame),
      });
        if (data) {
          if (flowData.value.storyboard.length === 0) {
            flowData.value.storyboard = data;
            return data;
          } else {
            flowData.value.storyboard.forEach((item) => {
              const findData = data.find((i: any) => i.id == item.id);
              if (findData) {
                item.state = findData.state;
                if (findData.src || findData.thumbSrc) {
                  applyImageState(item, findData.src, findData.thumbSrc);
                } else if (findData.state === "生成中") {
                  item.src = null;
                  item.thumbSrc = null;
                }
                item.reason = findData.reason ?? item.reason ?? "";
              }
            });
          }
        }
      startStoryboardPolling();
      return data;
    }
    async function batchGenerateAssets(allIds: number[]) {
      const uniqueIds = Array.from(new Set(allIds.filter((id): id is number => Number.isInteger(id))));
      if (!uniqueIds.length) return [];
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (uniqueIds.includes(derive.id)) {
              derive.state = "生成中" as "未生成" | "生成中" | "已完成" | "生成失败";
            }
          });
        }
      });
      try {
        const { data } = await axios.post("/production/assets/batchGenerateAssetsImage", {
          assetIds: uniqueIds,
          projectId: projectId,
          scriptId: episodesId.value,
          concurrentCount: settingStore().otherSetting.assetsBatchGenereateSize,
        });
        if (Array.isArray(data)) {
          data.forEach((record: { id: number; state: "未生成" | "生成中" | "已完成" | "生成失败"; src: string; thumbSrc?: string }) => {
            flowData.value.assets.forEach((asset) => {
              if (asset.derive) {
                asset.derive.forEach((derive) => {
                  if (derive.id === record.id) {
                    derive.state = record.state;
                    applyImageState(derive, record.src, record.thumbSrc);
                  }
                });
              }
            });
          });
        }
        return data;
      } catch (e) {
        console.error("[batchGenerateAssets] error", e);
        return [];
      }
    }
    const assetsNotStateImageIds = computed(() => {
      const ids: number[] = [];
      flowData.value.assets.forEach((asset) => {
        if (asset.derive) {
          asset.derive.forEach((derive) => {
            if (derive.state == ("生成中" as "未生成" | "生成中" | "已完成" | "生成失败")) {
              ids.push(derive.id);
            }
          });
        }
      });
      return ids;
    });
    const storyboardNotStateImageIds = computed(() => {
      const ids: number[] = [];
      flowData.value.storyboard.forEach((asset) => {
        if (asset.state == "生成中" && asset.id) {
          ids.push(asset.id);
        }
      });
      return ids;
    });
    // ---- 资产图片轮询 ----
    let assetsPollingTimer: number | null = null;
    let assetsPollingInFlight = false;

    async function pollAssetsImages() {
      const ids = assetsNotStateImageIds.value;
      if (ids.length === 0 || assetsPollingInFlight) return;
      assetsPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/assets/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; thumbSrc?: string; errorReason?: string; prompt?: string }>;
        records.forEach((record) => {
          flowData.value.assets.forEach((asset) => {
            if (!asset.derive) return;
            asset.derive.forEach((derive) => {
              if (derive.id === record.id) {
                derive.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
                if (record.src || record.thumbSrc) {
                  applyImageState(derive, record.src, record.thumbSrc);
                }
                derive.errorReason = record?.errorReason ?? "";
                derive.prompt = record?.prompt ?? "";
              }
            });
          });
        });
      } catch (e) {
        console.error("[assetsPolling] error", e);
      } finally {
        assetsPollingInFlight = false;
      }
    }

    function startAssetsPolling() {
      if (assetsPollingTimer) return;
      assetsPollingTimer = window.setInterval(async () => {
        if (assetsNotStateImageIds.value.length === 0) {
          stopAssetsPolling();
          return;
        }
        await pollAssetsImages();
      }, 5000);
      // 立即执行一次
      pollAssetsImages();
    }

    function stopAssetsPolling() {
      if (assetsPollingTimer) {
        clearInterval(assetsPollingTimer);
        assetsPollingTimer = null;
      }
    }

    watch(
      () => assetsNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startAssetsPolling();
        } else {
          stopAssetsPolling();
        }
      },
    );

    // ---- 分镜图片轮询 ----
    let storyboardPollingTimer: number | null = null;
    let storyboardPollingInFlight = false;

    async function pollStoryboardImages() {
      const ids = storyboardNotStateImageIds.value;
      if (ids.length === 0 || storyboardPollingInFlight) return;
      storyboardPollingInFlight = true;
      try {
        const { data } = await axios.post("/production/storyboard/pollingImage", {
          ids: ids,
        });
        if (!data || data.length === 0) return;
        const records = data as Array<{ id: number; state: string; src?: string; thumbSrc?: string; reason?: string }>;
        records.forEach((record) => {
          const item = flowData.value.storyboard.find((s) => s.id === record.id);
          if (item) {
            item.state = record.state as "未生成" | "生成中" | "已完成" | "生成失败";
            if (record.src || record.thumbSrc) {
              applyImageState(item, record.src, record.thumbSrc);
            }
            item.reason = record?.reason ?? "";
          }
        });
      } catch (e) {
        console.error("[storyboardPolling] error", e);
      } finally {
        storyboardPollingInFlight = false;
      }
    }

    function startStoryboardPolling() {
      if (storyboardPollingTimer) return;
      storyboardPollingTimer = window.setInterval(async () => {
        if (storyboardNotStateImageIds.value.length === 0) {
          stopStoryboardPolling();
          return;
        }
        await pollStoryboardImages();
      }, 5000);
      // 立即执行一次
      pollStoryboardImages();
    }

    function stopStoryboardPolling() {
      if (storyboardPollingTimer) {
        clearInterval(storyboardPollingTimer);
        storyboardPollingTimer = null;
      }
    }

    watch(
      () => storyboardNotStateImageIds.value,
      (ids) => {
        if (ids.length > 0) {
          startStoryboardPolling();
        } else {
          stopStoryboardPolling();
        }
      },
    );

    function updateContext() {
      if (episodesId.value! < 0) return;
      const ctx = {
        isolationKey: `${projectId}:productionAgent:${episodesId.value}`,
        projectId: projectId,
        scriptId: episodesId.value,
      };
      if (!connected.value) connect();
      socket.value!.emit("updateContext", ctx);
    }
    async function addStoryboardInfo(items: any[]) {
      const { data } = await axios.post("/production/storyboard/batchAddStoryboardInfo", {
        scriptId: episodesId.value,
        data: items,
        projectId: projectId,
      });

      flowData.value.storyboard.forEach((item) => {
        const updated = data.find((d: Storyboard) => d.prompt == item.prompt && d.duration == item.duration && d.videoDesc == item.videoDesc);
        if (updated) {
          item.id = updated.id;
          item.trackId = updated.trackId;
          applyImageState(item, updated.src, updated.thumbSrc);
          item.state = updated.state;
          item.associateAssetsIds = updated.associateAssetsIds;
        }
      });
    }

    const loadingHistory = ref(false);
    type GetHistoryOptions = {
      /**
       * Socket reconnects should not overwrite an existing local conversation.
       * The production page still calls getHistory() explicitly when switching episodes.
       */
      onlyWhenEmpty?: boolean;
      force?: boolean;
    };

    function isGeneratingStatus(value: unknown) {
      return value === "pending" || value === "streaming";
    }

    function hasConversationMessages() {
      return messages.value.some((message: any) => message?.id !== "welcome");
    }

    function hasActiveConversationMessage() {
      if (isGeneratingStatus(status.value)) return true;
      return messages.value.some((message: any) => {
        if (isGeneratingStatus(message?.status)) return true;
        if (!Array.isArray(message?.content)) return false;
        return message.content.some((content: any) => isGeneratingStatus(content?.status));
      });
    }

    async function getHistory(options: GetHistoryOptions = {}) {
      const { onlyWhenEmpty = false, force = false } = options;
      if (!force) {
        if (loadingHistory.value) return;
        if (onlyWhenEmpty && hasConversationMessages()) return;
        if (hasActiveConversationMessage()) return;
      }

      loadingHistory.value = true;
      try {
        const { data } = await axios.post(`/agents/getMemory`, {
          projectId: projectId,
          episodesId: episodesId.value,
          agentType: "productionAgent",
        });
        if (!force) {
          if (onlyWhenEmpty && hasConversationMessages()) return;
          if (hasActiveConversationMessage()) return;
        }
        messages.value = [...defMsg, ...(Array.isArray(data) ? data : [])];
        currentMessageId.value = null;
        status.value = "idle";
      } finally {
        loadingHistory.value = false;
      }
    }

    async function clearCurrentEpisodeContent() {
      const currentEpisodesId = Number(episodesId.value);
      if (!Number.isInteger(currentEpisodesId) || currentEpisodesId <= 0) {
        throw new Error("缺少当前分集，无法清空视频生产内容");
      }
      stopAssetsPolling();
      stopStoryboardPolling();
      const res = await axios.post("/production/clearEpisodeContent", {
        projectId: Number(projectId),
        episodesId: currentEpisodesId,
        clearAgentMemory: true,
      });
      await getFlowData(currentEpisodesId);
      await getHistory({ force: true });
      return res.data;
    }

    const thinkLevel = ref(0);

    function updateThinkConfig(value: number) {
      thinkLevel.value = value;
      if (socket.value) {
        socket.value.emit("updateThinkConfig", { think: value > 0, thinlLevel: value });
      }
    }

    return {
      connected,
      messages,
      chat,
      stopGenerate,
      socket,
      status,
      flowData,
      setFlowData,
      getFlowData,
      episodesId,
      stopAssetsPolling,
      stopStoryboardPolling,
      updateContext,
      getHistory,
      loadingHistory,
      batchGenerateStoryboard,
      reconnect,
      thinkLevel,
      updateThinkConfig,
      clearCurrentEpisodeContent,
    };
  });
}

const storeMap = new Map<string, ReturnType<typeof makeProductionAgentStore>>();

function createProductionAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeProductionAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useProductionAgentStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createProductionAgentStore(id)();
}
