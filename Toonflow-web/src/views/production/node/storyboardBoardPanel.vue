<template>
  <div class="storyboardBoardPanel">
    <div class="boardHeader">
      <div>
        <div class="boardTitle">分镜图辅助故事板模式</div>
        <div class="boardDesc">根据剧本和分镜文本由 Agent 自动分割故事板，再生成分镜头脚本页，用单图辅助视频生成。</div>
      </div>
      <t-space>
        <t-button size="small" variant="outline" :loading="listLoading" @click="loadBoards">刷新</t-button>
        <t-button size="small" theme="primary" :disabled="!availableStoryboardIds.length" :loading="createLoading" @click="createCurrentRange">
          生成故事板（自动分割）
        </t-button>
      </t-space>
    </div>

    <div class="boardControls">
      <t-radio-group v-model="rangeMode" size="small" variant="default-filled">
        <t-radio-button value="all">全部</t-radio-button>
        <t-radio-button value="selected">当前选择</t-radio-button>
        <t-radio-button value="range">Sxx-Sxx</t-radio-button>
      </t-radio-group>
      <t-select
        v-if="rangeMode === 'selected'"
        v-model="selectedStoryboardIds"
        size="small"
        class="storyboardSelect"
        multiple
        filterable
        placeholder="选择分镜">
        <t-option v-for="item in selectableStoryboards" :key="item.id" :value="item.id" :label="item.label" />
      </t-select>
      <template v-if="rangeMode === 'range'">
        <t-input-number v-model="rangeStart" size="small" :min="1" :max="storyboardCount || 1" label="起始 S" />
        <t-input-number v-model="rangeEnd" size="small" :min="1" :max="storyboardCount || 1" label="结束 S" />
      </template>
      <t-tag theme="primary" variant="light">故事板图片固定 9:16 竖版</t-tag>
    </div>

    <div class="videoControls">
      <t-select
        v-model="selectedModel"
        size="small"
        class="modelSelect"
        filterable
        :loading="modelLoading"
        placeholder="选择支持单图的视频模型"
        @change="handleModelChange">
        <t-option v-for="item in singleImageVideoModels" :key="item.modelId" :value="item.modelId" :label="item.label" />
      </t-select>
      <t-select v-model="duration" size="small" class="smallSelect" :disabled="!durationOptions.length">
        <t-option v-for="item in durationOptions" :key="item" :value="item" :label="`${item}s`" />
      </t-select>
      <t-select v-model="resolution" size="small" class="smallSelect" :disabled="!resolutionOptions.length">
        <t-option v-for="item in resolutionOptions" :key="item" :value="item" :label="item" />
      </t-select>
      <t-switch v-model="audio" size="small" :disabled="selectedModelDetail?.audio === false" @change="audioTouched = true" />
      <span class="audioLabel">音频</span>
    </div>

    <t-alert
      class="workbenchHint"
      theme="info"
      message="故事板视频的提示词编辑、生成提示词和生成视频入口已接入：视频生产工作台 → 视频生成 → 模式选择「故事板模式」。本工作区只负责故事板图片创建、重生成和调试预览。" />

    <t-alert v-if="!singleImageVideoModels.length && !modelLoading" theme="warning" message="没有可用的单图视频模型，请先在设置中启用支持 singleImage 的视频模型。" />

    <div v-if="boards.length" class="boardList">
      <div v-for="board in boards" :key="board.id" class="boardCard">
        <div class="boardThumbWrap" @click="previewBoard(board)">
          <img v-if="board.thumbUrl || board.imageUrl" class="boardThumb" :src="board.thumbUrl || board.imageUrl" loading="lazy" />
          <div v-else class="boardThumb boardThumbPlaceholder">
            <span>{{ board.state === "生成中" ? "等待生成" : "无故事板图" }}</span>
          </div>
        </div>
        <div class="boardInfo">
          <div class="boardName">{{ formatBoardRange(board) }}</div>
          <div class="boardMeta">
            分镜头脚本 · {{ board.storyboardIds.length }} 个镜头 · 目标 {{ board.targetDuration || duration }}s · 9:16 竖版
          </div>
          <div class="boardState" :class="stateClass(board.state)">
            图片：{{ board.state }}<span v-if="board.errorReason"> · {{ board.errorReason }}</span>
          </div>
          <div class="boardState" :class="stateClass(board.video?.state)">
            视频：{{ board.video?.state || "未生成" }}<span v-if="board.video?.errorReason"> · {{ board.video.errorReason }}</span>
          </div>
        </div>
        <div class="boardActions">
          <t-button size="small" variant="outline" @click="previewBoard(board)">预览图片</t-button>
          <t-button size="small" variant="outline" :loading="regeneratingBoardId === board.id" :disabled="board.state === '生成中'" @click="regenerateBoard(board)">
            重生成图片
          </t-button>
          <t-button size="small" theme="primary" :loading="generatingBoardId === board.id" :disabled="board.state !== '已完成' || !selectedModel" @click="generateVideo(board)">
            故事板图生视频
          </t-button>
          <t-button size="small" variant="outline" :disabled="!board.videoReferenceFrames?.length" @click="previewReferenceFrames(board)">参考帧</t-button>
          <t-button size="small" variant="outline" :disabled="!board.requestImageUrl" @click="previewRequestImage(board)">请求图</t-button>
          <t-button size="small" variant="outline" :disabled="!board.video?.prompt && !board.shotTimelineItems?.length" @click="openDebugDialog(board)">
            提示词
          </t-button>
          <t-button size="small" variant="outline" :disabled="!board.video?.src" @click="previewVideo(board)">预览视频</t-button>
          <t-button size="small" variant="outline" :disabled="!board.imageUrl" @click="openUrl(board.imageUrl)">下载图片</t-button>
          <t-button size="small" variant="outline" :disabled="!board.video?.src" @click="openUrl(board.video?.src || '')">下载视频</t-button>
          <t-button size="small" theme="danger" variant="outline" @click="deleteBoard(board)">删除</t-button>
        </div>
      </div>
    </div>
    <t-empty v-else description="暂无故事板" />

    <t-image-viewer v-model:visible="imagePreviewVisible" :images="imagePreviewImages" :imageScale="{ max: 10, min: 0.1 }" />
    <t-dialog v-model:visible="videoPreviewVisible" header="故事板视频预览" width="760px" :footer="false">
      <video v-if="currentVideoSrc" class="videoPreview" :src="currentVideoSrc" controls autoplay />
    </t-dialog>
    <t-dialog v-model:visible="debugVisible" header="故事板视频调试信息" width="980px" :footer="false" class="storyboardDebugDialog">
      <div v-if="debugBoard" class="debugPanel">
        <t-space class="debugActions">
          <t-button size="small" variant="outline" :disabled="!debugBoard.requestImageUrl" @click="previewRequestImage(debugBoard)">预览实际请求图</t-button>
          <t-button size="small" variant="outline" :disabled="!debugBoard.videoReferenceFrames?.length" @click="previewReferenceFrames(debugBoard)">预览视频参考帧</t-button>
          <t-button size="small" variant="outline" :disabled="!debugBoard.video?.prompt" @click="copyText(debugBoard.video?.prompt || '')">复制 prompt</t-button>
        </t-space>
        <div class="debugMeta">
          {{ formatBoardRange(debugBoard) }} · 模型：{{ debugBoard.video?.model || selectedModel || "-" }} · 时长：{{ debugBoard.video?.duration || duration }}s ·
          Prompt 长度：{{ debugBoard.video?.promptLength || debugBoard.video?.prompt?.length || 0 }} 字符 / {{ debugBoard.video?.promptBytes || 0 }} bytes
        </div>
        <t-tabs default-value="prompt">
          <t-tab-panel value="prompt" label="实际 prompt">
            <pre class="debugText">{{ debugBoard.video?.prompt || "尚未生成视频 prompt" }}</pre>
          </t-tab-panel>
          <t-tab-panel value="timeline" label="shotTimeline">
            <pre class="debugText">{{ formatJson(debugBoard.shotTimelineItems || []) }}</pre>
          </t-tab-panel>
          <t-tab-panel value="narrative" label="lockedNarrative">
            <pre class="debugText">{{ formatJson(debugBoard.lockedNarrativeData || {}) }}</pre>
          </t-tab-panel>
          <t-tab-panel value="script" label="分镜头脚本">
            <pre class="debugText">{{ debugBoard.shotScript || "无分镜头脚本" }}</pre>
          </t-tab-panel>
        </t-tabs>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import { DialogPlugin, LoadingPlugin } from "tdesign-vue-next";
import type { Storyboard } from "../utils/flowBuilder";

type BoardState = "未生成" | "生成中" | "已完成" | "生成失败";

interface StoryboardBoardVideo {
  id: number;
  videoId: number;
  model: string;
  prompt: string;
  promptLength?: number;
  promptBytes?: number;
  duration: number;
  resolution: string;
  state: BoardState;
  errorReason?: string;
  src?: string;
}

interface StoryboardVideoReferenceFrame {
  shotNo: number;
  filePath: string;
  duration: number;
  imageUrl: string;
  thumbUrl?: string;
  owned?: boolean;
}

interface StoryboardBoard {
  id: number;
  projectId: number;
  scriptId: number;
  storyboardIds: number[];
  startIndex: number;
  endIndex: number;
  filePath?: string;
  thumbPath?: string;
  imageUrl: string;
  thumbUrl: string;
  layout?: string;
  ratio?: string;
  shotScript?: string;
  imagePrompt?: string;
  imageModel?: string;
  sourceType?: string;
  targetDuration?: number;
  videoReferencePath?: string;
  videoReferenceUrl?: string;
  requestImageUrl?: string;
  videoReferenceMode?: string;
  videoReferenceFrames?: StoryboardVideoReferenceFrame[];
  shotTimelineItems?: any[];
  lockedNarrativeData?: any;
  state: BoardState;
  errorReason?: string;
  video?: StoryboardBoardVideo | null;
}

interface VideoModelDetail {
  name: string;
  modelName: string;
  mode: Array<string | string[]>;
  audio: boolean | "optional";
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
}

interface SingleImageVideoModel {
  modelId: string;
  label: string;
  detail: VideoModelDetail;
}

const props = defineProps<{
  projectId?: number | null;
  scriptId?: number | null;
  storyboard: Storyboard[];
  projectVideoModel?: string | null;
}>();

const boards = ref<StoryboardBoard[]>([]);
const listLoading = ref(false);
const createLoading = ref(false);
const modelLoading = ref(false);
const generatingBoardId = ref<number | null>(null);
const regeneratingBoardId = ref<number | null>(null);
const rangeStart = ref(1);
const rangeEnd = ref(1);
const rangeMode = ref<"all" | "selected" | "range">("all");
const selectedStoryboardIds = ref<number[]>([]);
const layout = ref("script");
const selectedModel = ref("");
const duration = ref(6);
const resolution = ref("");
const audio = ref(true);
const audioTouched = ref(false);
const singleImageVideoModels = ref<SingleImageVideoModel[]>([]);
const imagePreviewVisible = ref(false);
const imagePreviewImages = ref<string[]>([]);
const videoPreviewVisible = ref(false);
const currentVideoSrc = ref("");
const debugVisible = ref(false);
const debugBoard = ref<StoryboardBoard | null>(null);
const GROK_VIDEO_DURATIONS = [4, 5, 6, 7, 8, 9, 10] as const;
const GROK_VIDEO_15_PREVIEW_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const storyboardCount = computed(() => props.storyboard.length);
const selectableStoryboards = computed(() =>
  props.storyboard
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id)
    .map(({ item, index }) => ({
      id: item.id as number,
      label: `S${String(index + 1).padStart(2, "0")}`,
      index,
    })),
);
const availableStoryboardIds = computed(() => {
  if (rangeMode.value === "selected") {
    const selected = new Set(selectedStoryboardIds.value);
    return selectableStoryboards.value.filter((item) => selected.has(item.id)).map((item) => item.id);
  }
  if (rangeMode.value === "range") {
    return selectableStoryboards.value.filter((item) => item.index + 1 >= rangeStart.value && item.index + 1 <= rangeEnd.value).map((item) => item.id);
  }
  return selectableStoryboards.value.map((item) => item.id);
});
const selectedModelDetail = computed(() => singleImageVideoModels.value.find((item) => item.modelId === selectedModel.value)?.detail);
const durationOptions = computed(() => {
  const detail = selectedModelDetail.value;
  const durations = new Set<number>();
  detail?.durationResolutionMap?.forEach((item) => item.duration?.forEach((value) => durations.add(Number(value))));
  return Array.from(durations).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
});
const resolutionOptions = computed(() => {
  const detail = selectedModelDetail.value;
  const resolutions = new Set<string>();
  detail?.durationResolutionMap?.forEach((item) => {
    const durations = item.duration?.map((value) => Number(value)) ?? [];
    if (!durations.length || durations.includes(duration.value)) {
      item.resolution?.forEach((value) => resolutions.add(value));
    }
  });
  return Array.from(resolutions);
});
const hasRunningTask = computed(() => boards.value.some((item) => item.video?.state === "生成中"));

function modeSupportsSingleImage(mode: unknown) {
  if (!Array.isArray(mode)) return false;
  return mode.some((item) => item === "singleImage" || (Array.isArray(item) && item.includes("singleImage")));
}

function isGrokVideoModel(modelId: string, detail: VideoModelDetail) {
  const value = `${modelId} ${detail.name} ${detail.modelName}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video") || (value.includes("grok") && value.includes("imagine") && value.includes("video"));
}

function isGrokVideo15PreviewModel(modelId: string, detail: VideoModelDetail) {
  const value = `${modelId} ${detail.name} ${detail.modelName}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video-1.5-preview") || value.includes("grokimaginevideo1.5preview");
}

function getGrokVideoDurations(modelId: string, detail: VideoModelDetail) {
  if (isGrokVideo15PreviewModel(modelId, detail)) {
    return [...GROK_VIDEO_15_PREVIEW_DURATIONS];
  }
  return [...GROK_VIDEO_DURATIONS];
}

function normalizeModelDetail(modelId: string, detail: VideoModelDetail): VideoModelDetail {
  if (!isGrokVideoModel(modelId, detail)) return detail;
  const durations = getGrokVideoDurations(modelId, detail);
  return {
    ...detail,
    durationResolutionMap: detail.durationResolutionMap?.map((item) => ({ ...item, duration: durations })) ?? [{ duration: durations, resolution: [] }],
  };
}

async function loadVideoModels() {
  modelLoading.value = true;
  try {
    const { data } = await axios.post("/modelSelect/getModelList", { type: "video" });
    const details = await Promise.all(
      data.map(async (item: any) => {
        const modelId = `${item.id}:${item.value}`;
        try {
          const { data: detail } = await axios.post("/modelSelect/getModelDetail", { modelId });
          const normalizedDetail = normalizeModelDetail(modelId, detail);
          if (!modeSupportsSingleImage(normalizedDetail.mode)) return null;
          return {
            modelId,
            label: `${item.name} / ${item.label}`,
            detail: normalizedDetail,
          } satisfies SingleImageVideoModel;
        } catch {
          return null;
        }
      }),
    );
    singleImageVideoModels.value = details.filter((item): item is SingleImageVideoModel => item != null);
    selectedModel.value =
      singleImageVideoModels.value.find((item) => item.modelId === props.projectVideoModel)?.modelId || singleImageVideoModels.value[0]?.modelId || "";
    applyModelDefaults();
  } finally {
    modelLoading.value = false;
  }
}

function applyModelDefaults() {
  const durations = durationOptions.value;
  if (durations.length && !durations.includes(duration.value)) duration.value = durations[0];
  const resolutions = resolutionOptions.value;
  if (resolutions.length && !resolutions.includes(resolution.value)) resolution.value = resolutions[0];
  if (selectedModelDetail.value?.audio === false) audio.value = false;
  else if (!audioTouched.value) audio.value = true;
}

function handleModelChange() {
  audioTouched.value = false;
  applyModelDefaults();
}

function formatBoardRange(board: StoryboardBoard) {
  const start = `S${String(Number(board.startIndex ?? 0) + 1).padStart(2, "0")}`;
  const end = `S${String(Number(board.endIndex ?? 0) + 1).padStart(2, "0")}`;
  return start === end ? start : `${start}-${end}`;
}

function stateClass(state?: string | null) {
  return {
    success: state === "已完成",
    running: state === "生成中",
    failed: state === "生成失败",
  };
}

async function loadBoards() {
  if (!props.projectId || !props.scriptId) return;
  listLoading.value = true;
  try {
    const { data } = await axios.post("/production/storyboardBoard/list", {
      projectId: props.projectId,
      scriptId: props.scriptId,
    });
    boards.value = data;
  } finally {
    listLoading.value = false;
  }
}

async function createBoard(storyboardIds: number[]) {
  if (!props.projectId || !props.scriptId || !storyboardIds.length) return;
  await axios.post("/production/storyboardBoard/create", {
    projectId: props.projectId,
    scriptId: props.scriptId,
    storyboardIds,
    layout: layout.value,
    ratio: "9:16",
    targetDuration: duration.value,
  });
}

async function createCurrentRange() {
  if (!availableStoryboardIds.value.length) {
    window.$message.warning("当前范围没有可用分镜文本");
    return;
  }
  LoadingPlugin(true);
  createLoading.value = true;
  try {
    await createBoard(availableStoryboardIds.value);
    await loadBoards();
    window.$message.success("故事板已按 Agent 自动分割开始生成");
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板生成失败");
  } finally {
    createLoading.value = false;
    LoadingPlugin(false);
  }
}

function previewBoard(board: StoryboardBoard) {
  if (!board.imageUrl) return;
  imagePreviewImages.value = [board.imageUrl];
  imagePreviewVisible.value = true;
}

function previewVideo(board: StoryboardBoard) {
  if (!board.video?.src) return;
  currentVideoSrc.value = board.video.src;
  videoPreviewVisible.value = true;
}

function previewReferenceFrames(board: StoryboardBoard) {
  const images = board.videoReferenceFrames?.map((item) => item.imageUrl).filter(Boolean) || [];
  if (!images.length) return;
  imagePreviewImages.value = images;
  imagePreviewVisible.value = true;
}

function previewRequestImage(board: StoryboardBoard) {
  if (!board.requestImageUrl) return;
  imagePreviewImages.value = [board.requestImageUrl];
  imagePreviewVisible.value = true;
}

function openDebugDialog(board: StoryboardBoard) {
  debugBoard.value = board;
  debugVisible.value = true;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

async function copyText(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  window.$message.success("已复制");
}

function openUrl(url: string) {
  if (!url) return;
  window.open(url, "_blank");
}

async function confirmGenerate(board: StoryboardBoard) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let dialog: ReturnType<typeof DialogPlugin.confirm>;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      dialog.destroy();
      resolve(confirmed);
    };
    dialog = DialogPlugin.confirm({
      header: "确认生成故事板视频",
      body: `将使用 ${selectedModel.value || "-"} 读取故事板单图和分镜头脚本，生成 ${formatBoardRange(board)} 的故事板视频，时长 ${duration.value}s，分辨率 ${resolution.value || "-"}。`,
      confirmBtn: "开始生成",
      cancelBtn: "取消",
      closeOnOverlayClick: false,
      closeOnEscKeydown: false,
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}

async function generateVideo(board: StoryboardBoard) {
  if (!selectedModel.value || !duration.value || !resolution.value) {
    window.$message.warning("请选择模型、时长和分辨率");
    return;
  }
  if (!(await confirmGenerate(board))) return;
  generatingBoardId.value = board.id;
  try {
    await axios.post("/production/storyboardBoard/generateVideo", {
      boardId: board.id,
      model: selectedModel.value,
      duration: duration.value,
      resolution: resolution.value,
      audio: audio.value,
    });
    window.$message.success("故事板视频已开始生成");
    await loadBoards();
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板视频生成失败");
  } finally {
    generatingBoardId.value = null;
  }
}

async function confirmRegenerate(board: StoryboardBoard) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let dialog: ReturnType<typeof DialogPlugin.confirm>;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      dialog.destroy();
      resolve(confirmed);
    };
    dialog = DialogPlugin.confirm({
      header: "重新生成故事板图片",
      body: `将重新生成 ${formatBoardRange(board)} 的故事板图片，并清理该故事板已生成的视频记录。分镜面板和资产不会被删除。`,
      confirmBtn: "重新生成",
      cancelBtn: "取消",
      closeOnOverlayClick: false,
      closeOnEscKeydown: false,
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}

async function regenerateBoard(board: StoryboardBoard) {
  if (!(await confirmRegenerate(board))) return;
  regeneratingBoardId.value = board.id;
  try {
    await axios.post("/production/storyboardBoard/regenerate", { boardId: board.id });
    window.$message.success("故事板图片已开始重新生成");
    await loadBoards();
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板图片重新生成失败");
  } finally {
    regeneratingBoardId.value = null;
  }
}

async function deleteBoard(board: StoryboardBoard) {
  const dialog = DialogPlugin.confirm({
    header: "删除故事板",
    body: `确认删除 ${formatBoardRange(board)} 的分镜头脚本、故事板图片及其故事板视频记录？不会删除分镜面板或资产。`,
    theme: "warning",
    confirmBtn: "删除",
    cancelBtn: "取消",
    onConfirm: async () => {
      try {
        await axios.post("/production/storyboardBoard/delete", { boardId: board.id });
        await loadBoards();
        window.$message.success("已删除故事板");
      } catch (e) {
        window.$message.error((e as any)?.message || "删除失败");
      } finally {
        dialog.destroy();
      }
    },
  });
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void loadBoards();
  }, 3000);
}

function stopPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

watch(
  () => storyboardCount.value,
  (count) => {
    rangeEnd.value = Math.max(1, count || 1);
  },
  { immediate: true },
);
watch([durationOptions, resolutionOptions], () => applyModelDefaults());
watch(hasRunningTask, (running) => {
  if (running) startPoll();
  else stopPoll();
});
watch(
  () => [props.projectId, props.scriptId],
  () => {
    void loadBoards();
  },
);

onMounted(() => {
  void loadBoards();
  void loadVideoModels();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style lang="scss" scoped>
.storyboardBoardPanel {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--td-border-level-1-color);
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(255, 248, 231, 0.72), rgba(238, 246, 255, 0.82));

  .boardHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  .boardTitle {
    font-size: 15px;
    font-weight: 700;
    color: var(--td-text-color-primary);
  }

  .boardDesc {
    margin-top: 3px;
    font-size: 12px;
    color: var(--td-text-color-secondary);
  }

  .boardControls,
  .videoControls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }

  .controlSelect {
    width: 120px;
  }

  .storyboardSelect {
    width: 260px;
  }

  .modelSelect {
    width: 320px;
  }

  .smallSelect {
    width: 108px;
  }

  .audioLabel {
    font-size: 12px;
    color: var(--td-text-color-secondary);
  }

  .workbenchHint {
    margin-bottom: 10px;
  }

  .boardList {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
  }

  .boardCard {
    display: grid;
    grid-template-columns: 128px minmax(220px, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 10px;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.86);
  }

  .boardThumbWrap,
  .boardThumb {
    width: 128px;
    height: 82px;
  }

  .boardThumbWrap {
    border-radius: 8px;
    overflow: hidden;
    background: #f4f1ea;
  }

  .boardThumb {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border: 1px solid var(--td-border-level-1-color);
    cursor: zoom-in;
  }

  .boardThumbPlaceholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--td-text-color-placeholder);
    font-size: 12px;
    cursor: default;
  }

  .boardName {
    font-weight: 700;
    color: var(--td-text-color-primary);
  }

  .boardMeta,
  .boardState {
    margin-top: 4px;
    font-size: 12px;
    color: var(--td-text-color-secondary);
  }

  .boardState.success {
    color: var(--td-success-color);
  }

  .boardState.running {
    color: var(--td-brand-color);
  }

  .boardState.failed {
    color: var(--td-error-color);
  }

  .boardActions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    max-width: 360px;
  }
}

.videoPreview {
  width: 100%;
  max-height: 70vh;
  background: #000;
  border-radius: 8px;
}

.debugPanel {
  .debugActions {
    margin-bottom: 10px;
  }

  .debugMeta {
    margin-bottom: 10px;
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .debugText {
    max-height: 58vh;
    margin: 0;
    padding: 12px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 8px;
    background: #101418;
    color: #e8edf2;
    font-size: 12px;
    line-height: 1.6;
  }
}
</style>
