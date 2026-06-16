import { computed, onUnmounted, ref, unref, watch, type MaybeRef } from "vue";
import axios from "@/utils/axios";

type WorkflowState = "未生成" | "生成中" | "已完成" | "生成失败" | "已取消";

export interface StoryboardFirstScriptState {
  id: number;
  shotScript: string;
  scriptRevision: number;
  shotScriptHash: string;
  state: WorkflowState;
  errorReason: string;
  targetDuration?: number;
  segmentCount?: number;
}

export interface StoryboardFirstImageState {
  id: number;
  imageUrl: string;
  thumbUrl: string;
  version: number;
  imageSourceHash: string;
  stale: boolean;
  state: WorkflowState;
  errorReason: string;
}

export interface StoryboardFirstVideoState {
  id: number;
  videoId: number;
  src: string;
  imageSourceHash: string;
  stale: boolean;
  duration: number;
  resolution: string;
  aspectRatio: "9:16";
  state: WorkflowState;
  errorReason: string;
}

export interface StoryboardFirstWorkflowState {
  script: StoryboardFirstScriptState | null;
  image: StoryboardFirstImageState | null;
  latestVideo: StoryboardFirstVideoState | null;
  videoHistory: StoryboardFirstVideoState[];
}

const emptyState = (): StoryboardFirstWorkflowState => ({
  script: null,
  image: null,
  latestVideo: null,
  videoHistory: [],
});

const state = ref<StoryboardFirstWorkflowState>(emptyState());
const loading = ref(false);
const actionLoading = ref(false);
let currentProjectId: number | null = null;
let currentScriptId: number | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let subscribers = 0;

function currentKey(projectId?: number | null, scriptId?: number | null) {
  const pid = Number(projectId || 0);
  const sid = Number(scriptId || 0);
  return pid > 0 && sid > 0 ? `${pid}:${sid}` : "";
}

function hasRunningTask(value = state.value) {
  return [value.script?.state, value.image?.state, value.latestVideo?.state].includes("生成中");
}

function stopPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void load();
  }, 3000);
}

async function load() {
  if (loading.value || !currentProjectId || !currentScriptId) return;
  loading.value = true;
  try {
    const { data } = await axios.post("/production/storyboardFirst/list", {
      projectId: currentProjectId,
      scriptId: currentScriptId,
    });
    state.value = data || emptyState();
    if (hasRunningTask()) startPoll();
    else stopPoll();
  } finally {
    loading.value = false;
  }
}

function setContext(projectId?: number | null, scriptId?: number | null) {
  const nextKey = currentKey(projectId, scriptId);
  const prevKey = currentKey(currentProjectId, currentScriptId);
  if (nextKey === prevKey) return;

  stopPoll();
  state.value = emptyState();
  currentProjectId = Number(projectId || 0) || null;
  currentScriptId = Number(scriptId || 0) || null;
  void load();
}

async function withAction<T>(fn: () => Promise<T>) {
  actionLoading.value = true;
  try {
    const result = await fn();
    await load();
    if (hasRunningTask()) startPoll();
    return result;
  } finally {
    actionLoading.value = false;
  }
}

export function useStoryboardFirstWorkflow(projectId: MaybeRef<number | null | undefined>, scriptId: MaybeRef<number | null | undefined>) {
  subscribers += 1;

  const stopWatch = watch(
    () => [unref(projectId), unref(scriptId)] as const,
    ([pid, sid]) => setContext(pid, sid),
    { immediate: true },
  );

  onUnmounted(() => {
    stopWatch();
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) stopPoll();
  });

  return {
    state,
    loading,
    actionLoading,
    script: computed(() => state.value.script),
    image: computed(() => state.value.image),
    latestVideo: computed(() => state.value.latestVideo),
    videoHistory: computed(() => state.value.videoHistory || []),
    refresh: load,
    generateScript: (targetDuration?: number, force = false) =>
      withAction(() =>
        axios.post("/production/storyboardFirst/generateScript", {
          projectId: currentProjectId,
          scriptId: currentScriptId,
          targetDuration,
          force,
        }),
      ),
    updateScript: (firstScriptId: number, shotScript: string) =>
      withAction(() => axios.post("/production/storyboardFirst/updateScript", { firstScriptId, shotScript })),
    generateImage: (firstScriptId: number, force = false) =>
      withAction(() => axios.post("/production/storyboardFirst/generateImage", { firstScriptId, force })),
    regenerateImage: (firstImageId: number) =>
      withAction(() => axios.post("/production/storyboardFirst/regenerateImage", { firstImageId })),
    generateVideo: (payload: { firstImageId: number; model: string; duration: number; resolution: string; audio?: boolean }) =>
      withAction(() => axios.post("/production/storyboardFirst/generateVideo", payload)),
    deleteWorkflow: (payload: { firstScriptId?: number; firstImageId?: number }) =>
      withAction(() => axios.post("/production/storyboardFirst/delete", payload)),
    clearWorkflow: () =>
      withAction(() =>
        axios.post("/production/storyboardFirst/clear", {
          projectId: currentProjectId,
          scriptId: currentScriptId,
          confirm: true,
        }),
      ),
  };
}
