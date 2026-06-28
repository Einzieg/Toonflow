import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import settingStore from "@/stores/setting";
import { useChat } from "@/utils/useChat";

interface PlanData {
  storySkeleton: string;
  adaptationStrategy: string;
  script: { id?: number; name: string; content: string }[];
}

function makeScriptAgentStore(projectId: string) {
  return defineStore(`scriptAgent-${projectId}`, () => {
        const planData = ref<PlanData>({
          storySkeleton: "",
          adaptationStrategy: "",
          script: [],
        });

        const { connected, messages, chat, stopGenerate, socket, status, disconnect, connect } = useChat({
          url: `${settingStore().baseUrl}/socket/scriptAgent`,
          auth: () => ({
            isolationKey: `${projectId}:scriptAgent`,
            projectId: projectId,
          }),
          manageLifecycle: false,
          xmlTags: [
            { tag: "storySkeleton", keepInMessage: false },
            { tag: "adaptationStrategy", keepInMessage: false },
            { tag: "scriptItem", keepInMessage: false },
          ],
          onXmlTag: (data) => {
            const { tag, value, children, status, attrs } = data;
            if (tag === "storySkeleton") {
              planData.value.storySkeleton = value;
            } else if (tag === "adaptationStrategy") {
              planData.value.adaptationStrategy = value;
            } else if (tag === "scriptItem") {
              const name = attrs.name ?? "";
              const content = value;
              if (name) {
                const existingIndex = planData.value.script.findIndex((s) => s.name === name);
                if (existingIndex !== -1) {
                  planData.value.script[existingIndex].content = content;
                } else {
                  planData.value.script.push({ name, content });
                }
              }
            }
            if (status === "complete") {
              setPlanData();
            }
          },
          autoConnect: false,
        });

        watch(
          socket,
          (s) => {
            if (s) {
              s.on("getPlanData", (_, callback) => {
                callback(planData.value);
              });
              s.on("setStorySkeleton", (data, callback) => {
                planData.value.storySkeleton = data?.content ?? "";
                callback?.({ success: true, message: `已刷新故事骨架 ${planData.value.storySkeleton.length} 字` });
              });
              s.on("setAdaptationStrategy", (data, callback) => {
                planData.value.adaptationStrategy = data?.content ?? "";
                callback?.({ success: true, message: `已刷新改编策略 ${planData.value.adaptationStrategy.length} 字` });
              });
              s.on("setScriptItems", (data, callback) => {
                const items = Array.isArray(data?.items) ? data.items : [];
                for (const item of items) {
                  const existingIndex = planData.value.script.findIndex((script) => script.id === item.id || script.name === item.name);
                  if (existingIndex !== -1) {
                    planData.value.script[existingIndex] = item;
                  } else {
                    planData.value.script.push(item);
                  }
                }
                callback?.({ success: true, message: `已刷新剧本 ${items.length} 条` });
              });
            }
          },
          { immediate: true },
        );

        async function setPlanData() {
          await axios.post("/scriptAgent/setPlanData", { projectId: projectId, agentType: "scriptAgent", data: planData.value });
        }

        const thinkLevel = ref(0);

        function updateThinkConfig(value: number) {
          thinkLevel.value = value;
          if (socket.value) {
            socket.value.emit("updateThinkConfig", { think: value > 0, thinlLevel: value });
          }
        }

        return { connected, messages, chat, stopGenerate, socket, status, planData, setPlanData, connect, disconnect, thinkLevel, updateThinkConfig };
      });
}

const storeMap = new Map<string, ReturnType<typeof makeScriptAgentStore>>();

function createScriptAgentStore(projectId: string) {
  if (!storeMap.has(projectId)) {
    storeMap.set(projectId, makeScriptAgentStore(projectId));
  }
  return storeMap.get(projectId)!;
}

export default function useScriptAgentStore() {
  const id = projectStore().project?.id;
  if (!id) throw new Error("No project selected");
  return createScriptAgentStore(id)();
}
