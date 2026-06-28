<template>
  <section class="storyboardBoardMode">
    <t-alert v-if="!contextReady" theme="warning" :message="contextMissingMessage" />
    <t-alert v-else-if="loadError" theme="error" :message="loadError" />
    <t-alert v-else-if="!modelParmas.model" theme="warning" message="请先选择视频模型。" />
    <t-alert v-else-if="!loading && !boards.length" theme="info" message="暂无故事板，请先在故事板工作区生成故事板。" />

    <div class="generate ac">
      <div v-if="currentBoard" class="prompt">
        <t-card :title="'#' + (activeBoardIndex + 1) + ' 生成提示词'" header-bordered class="videoPrompt">
          <template #actions>
            <t-space>
              <t-button size="small" variant="outline" :loading="loading" @click="loadBoards">刷新</t-button>
              <t-button size="small" class="genTextbtn" :loading="activePromptGenerating" :disabled="!currentBoard" @click="currentBoard && generatePrompt(currentBoard)">生成提示词</t-button>
              <t-button
                size="small"
                variant="outline"
                theme="warning"
                :loading="activeBoardRegenerating"
                :disabled="!canRegenerateBoard(currentBoard)"
                @click="currentBoard && regenerateBoard(currentBoard)">
                重新生成故事板
              </t-button>
            </t-space>
          </template>
          <div class="storyboardMeta">
            <t-tag size="small" variant="light">共 {{ boards.length }} 段</t-tag>
            <t-tag size="small" :theme="stateTheme(displayBoard.state)">故事板图：{{ displayBoard.state }}</t-tag>
            <t-tag size="small" :theme="stateTheme(displayBoard.video?.state)">视频：{{ displayBoard.video?.state || "未生成" }}</t-tag>
            <span class="muted">{{ displayBoard.storyboardIds.length }} 镜头 · {{ displayBoard.video?.duration || modelParmas.duration }}s</span>
            <span v-if="displayBoard.errorReason || displayBoard.video?.errorReason" class="dangerText">{{ displayBoard.errorReason || displayBoard.video?.errorReason }}</span>
          </div>
          <div class="promptData fc">
            <div class="promptInput">
              <promptEditor
                v-model="activePrompt"
                :references="activeReferences"
                placeholder="点击生成提示词，或直接输入故事板图生视频 prompt。输入 @ 可插入参考图标签。" />
            </div>
            <div class="buttonRow promptActions">
              <t-button size="small" variant="outline" :disabled="!displayBoard.imageUrl" @click="previewImages([displayBoard.imageUrl])">故事板图</t-button>
              <t-button size="small" variant="outline" :disabled="!displayBoard.requestImageUrl" @click="previewImages([displayBoard.requestImageUrl || ''])">请求图</t-button>
              <t-button size="small" variant="outline" :disabled="!displayBoard.videoReferenceFrames?.length" @click="previewReferenceFrames(displayBoard)">参考帧</t-button>
              <t-button size="small" variant="outline" :disabled="!displayBoard.shotScript" @click="openScript(displayBoard)">分镜头脚本</t-button>
              <t-button
                size="small"
                variant="outline"
                theme="warning"
                :loading="activeBoardRegenerating"
                :disabled="!canRegenerateBoard(currentBoard)"
                @click="currentBoard && regenerateBoard(currentBoard)">
                重生成故事板
              </t-button>
              <t-button size="small" variant="outline" :disabled="!activePrompt" @click="copyPrompt">复制</t-button>
              <t-button size="small" variant="outline" :disabled="!currentBoard || !activePrompt || currentBoard.video?.state === '生成中'" @click="currentBoard && savePrompt(currentBoard)">保存</t-button>
            </div>
          </div>
        </t-card>
      </div>
      <div v-else class="prompt">
        <t-card title="生成提示词" header-bordered class="videoPrompt">
          <div class="emptyHistory c">暂无故事板</div>
        </t-card>
      </div>

      <div class="video">
        <t-card :title="'#' + (activeBoardIndex + 1) + ' 视频生成'" header-bordered class="videoPrompt">
          <template #actions>
            <t-button size="small" :loading="activeBoardGenerating" :disabled="!currentBoard" @click="currentBoard && generateVideo(currentBoard)">生成视频</t-button>
          </template>
          <div class="history">
            <div class="titleBox f ac">
              <i-time />
              <span class="title">视频历史（{{ activeVideos.length }}）</span>
            </div>
            <div class="historyItemBox">
              <div
                v-for="video in activeVideos"
                :key="video.id"
                class="historyItem"
                :class="{ generating: video.state === '生成中', failed: video.state === '生成失败' }"
                @click="previewVideo(video)">
                <video
                  v-if="video.src && video.state === '已完成'"
                  :src="video.src"
                  preload="metadata"
                  muted
                  @loadedmetadata="
                    (e: Event) => {
                      (e.target as HTMLVideoElement).currentTime = 0.5;
                    }
                  " />
                <div v-else class="videoPlaceholder c">{{ video.state === "已完成" && !video.src ? "视频链接不可用" : video.state }}</div>
                <div v-if="video.state === '生成中'" class="loadingOverlay c fc">
                  <t-loading size="24px" />
                  <span class="loadingText">生成中</span>
                </div>
                <t-tooltip v-if="video.state === '生成失败'" placement="top" :content="video.errorReason || ''" theme="light">
                  <t-tag class="stateTag" theme="danger" size="small">生成失败</t-tag>
                </t-tooltip>
                <div v-if="video.src && video.state !== '生成中' && video.state !== '生成失败'" class="download" @click.stop="downloadVideo(video)">
                  <i-to-bottom size="16" />
                </div>
                <div v-if="video.src && video.state !== '生成中' && video.state !== '生成失败'" class="playBtn" @click.stop="previewVideo(video)">
                  <i-play size="16" />
                </div>
              </div>
              <div v-if="!activeVideos.length" class="emptyHistory c">暂无视频历史</div>
            </div>
          </div>
        </t-card>
      </div>
    </div>

    <div v-if="boards.length" class="track videoTrack">
      <t-card bordered :style="{ height: '100%' }">
        <div class="trackMenu f ac jb">
          <div class="left f ac">
            <span class="trackTitle">故事板分段</span>
            <span class="selectedCount">当前共 {{ boards.length }} 段</span>
          </div>
          <div class="right f ac">
            <t-button size="small" variant="outline" :loading="loading" @click="loadBoards">刷新</t-button>
          </div>
        </div>
        <div class="itemBox">
          <div
            v-for="(board, index) in boards"
            :key="board.id"
            class="item"
            :title="`${formatBoardRange(board)} · ${board.storyboardIds.length} 镜头 · ${board.video?.duration || modelParmas.duration}s`"
            :class="{ active: index === activeBoardIndex }"
            @click="changeActiveBoard(index)">
            <t-tag class="stateTag" size="small" :theme="stateTheme(board.video?.state || board.state)">
              {{ board.video?.state || board.state }}
            </t-tag>
            <t-tag class="indexTag" size="small">#{{ index + 1 }}</t-tag>
            <t-tag v-if="index === activeBoardIndex" class="selectTag" size="small" theme="primary">当前</t-tag>
            <div v-if="board.thumbUrl || board.imageUrl" class="thumbGroup">
              <img class="thumb" :src="board.thumbUrl || board.imageUrl" loading="lazy" decoding="async" draggable="false" @error="handleImageError" />
            </div>
            <span v-else class="emptyTrack">{{ formatBoardRange(board) }} 暂无图片</span>
            <button
              class="regenBtn"
              :disabled="!canRegenerateBoard(board) || regeneratingBoardId === board.id"
              @click.stop="regenerateBoard(board)">
              {{ regeneratingBoardId === board.id ? "…" : "重" }}
            </button>
          </div>
        </div>
      </t-card>
    </div>

    <t-image-viewer
      v-model:visible="imagePreviewVisible"
      :images="imagePreviewImages"
      :imageScale="{ max: 10, min: 0.1 }"
      :trigger="renderImageViewerTrigger" />
    <t-dialog v-model:visible="scriptVisible" header="分镜头脚本" width="860px" :footer="false">
      <pre class="scriptText">{{ currentScript }}</pre>
    </t-dialog>
    <t-dialog v-model:visible="videoPreviewVisible" header="故事板视频预览" width="820px" :footer="false" destroy-on-close>
      <video v-if="currentVideoSrc" class="videoPreview" :src="currentVideoSrc" controls autoplay />
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import { DialogPlugin } from "tdesign-vue-next";
import promptEditor from "@/components/promptEditor.vue";
import "@/views/production/components/workbench/type/type";

type BoardState = "未生成" | "生成中" | "已完成" | "生成失败";

interface StoryboardBoardVideo {
  id: number;
  videoId: number | null;
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  state: BoardState;
  errorReason?: string;
  src: string;
}

interface StoryboardVideoReferenceFrame {
  imageUrl: string;
  thumbUrl?: string;
}

interface StoryboardBoard {
  id: number;
  storyboardIds: number[];
  startIndex: number;
  endIndex: number;
  imageUrl: string;
  thumbUrl: string;
  requestImageUrl?: string;
  videoReferenceFrames?: StoryboardVideoReferenceFrame[];
  shotScript?: string;
  state: BoardState;
  errorReason?: string;
  filePath?: string;
  thumbPath?: string;
  createTime?: number;
  updateTime?: number;
  video?: StoryboardBoardVideo | null;
  videos?: StoryboardBoardVideo[];
}

const VIDEO_PROMPT_TIMEOUT = 10 * 60 * 1000;
const STALE_STORYBOARD_BOARD_MS = 30 * 60 * 1000;

const props = defineProps<{
  projectId?: number | null;
  scriptId?: number | null;
  modelParmas: ModelSetting;
}>();

const boards = ref<StoryboardBoard[]>([]);
const activeBoardIndex = ref(0);
const promptDrafts = ref<Record<number, string>>({});
const promptGeneratingMap = ref<Record<number, boolean>>({});
const generatingBoardId = ref<number | null>(null);
const regeneratingBoardId = ref<number | null>(null);
const loading = ref(false);
const loadError = ref("");
const imagePreviewVisible = ref(false);
const imagePreviewImages = ref<string[]>([]);
const scriptVisible = ref(false);
const currentScript = ref("");
const videoPreviewVisible = ref(false);
const currentVideoSrc = ref("");
let pollTimer: ReturnType<typeof setInterval> | null = null;

function renderImageViewerTrigger() {
  return null;
}

const emptyBoard: StoryboardBoard = {
  id: 0,
  storyboardIds: [],
  startIndex: 0,
  endIndex: 0,
  imageUrl: "",
  thumbUrl: "",
  state: "未生成",
  errorReason: "",
  video: null,
  videos: [],
};
const currentBoard = computed(() => boards.value[activeBoardIndex.value]);
const displayBoard = computed(() => currentBoard.value || emptyBoard);
const hasCurrentBoard = computed(() => Boolean(currentBoard.value));
const running = computed(() =>
  boards.value.some((board) => board.state === "生成中" || board.video?.state === "生成中" || board.videos?.some((video) => video.state === "生成中")),
);
const contextReady = computed(() => props.projectId != null && props.scriptId != null);
const contextMissingMessage = computed(() => `故事板上下文未就绪，projectId=${props.projectId ?? "-"}，scriptId=${props.scriptId ?? "-"}`);
const activePromptGenerating = computed(() => {
  const boardId = currentBoard.value?.id;
  return boardId != null ? !!promptGeneratingMap.value[boardId] : false;
});
const activeBoardGenerating = computed(() => {
  const boardId = currentBoard.value?.id;
  return boardId != null && generatingBoardId.value === boardId;
});
const activeBoardRegenerating = computed(() => {
  const boardId = currentBoard.value?.id;
  return boardId != null && regeneratingBoardId.value === boardId;
});
const activeVideos = computed(() => {
  const board = currentBoard.value;
  if (!board) return [];
  const videos = Array.isArray(board.videos) ? [...board.videos] : [];
  if (board.video && !videos.some((video) => video.id === board.video?.id)) videos.unshift(board.video);
  return videos;
});
const activePrompt = computed({
  get() {
    const boardId = currentBoard.value?.id;
    return boardId == null ? "" : promptDrafts.value[boardId] || "";
  },
  set(value: string) {
    const boardId = currentBoard.value?.id;
    if (boardId == null) return;
    promptDrafts.value[boardId] = value;
  },
});
const activeReferences = computed(() => {
  const board = currentBoard.value;
  if (!board) return [];
  return [board.imageUrl, board.requestImageUrl, ...(board.videoReferenceFrames || []).map((item) => item.imageUrl)]
    .filter((src): src is string => Boolean(src))
    .map((src) => ({ type: "image" as const, src }));
});
function formatBoardRange(board: StoryboardBoard) {
  const start = `S${String(Number(board.startIndex ?? 0) + 1).padStart(2, "0")}`;
  const end = `S${String(Number(board.endIndex ?? 0) + 1).padStart(2, "0")}`;
  return start === end ? start : `${start}-${end}`;
}

function stateTheme(state?: string | null) {
  if (state === "已完成") return "success";
  if (state === "生成中") return "primary";
  if (state === "生成失败") return "danger";
  return "default";
}

function syncPromptDrafts(nextBoards: StoryboardBoard[]) {
  const nextIds = new Set(nextBoards.map((board) => board.id));
  Object.keys(promptDrafts.value).forEach((id) => {
    if (!nextIds.has(Number(id))) delete promptDrafts.value[Number(id)];
  });
  nextBoards.forEach((board) => {
    const latestPrompt = board.video?.prompt || "";
    if (promptDrafts.value[board.id] == null || promptDrafts.value[board.id] === "") {
      promptDrafts.value[board.id] = latestPrompt;
    }
  });
}

function hasRenderableBoardImage(board?: StoryboardBoard | null) {
  return Boolean(board?.imageUrl || board?.thumbUrl);
}

function isStaleGeneratingBoard(board?: StoryboardBoard | null) {
  if (board?.state !== "生成中") return false;
  const timestamp = Number(board.updateTime || board.createTime || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  return !hasRenderableBoardImage(board) && Date.now() - timestamp > STALE_STORYBOARD_BOARD_MS;
}

function canRegenerateBoard(board?: StoryboardBoard | null) {
  if (!board) return false;
  return board.state !== "生成中" || isStaleGeneratingBoard(board);
}

function normalizeActiveBoardIndex(nextBoards: StoryboardBoard[], preferredBoardId?: number | null) {
  if (!nextBoards.length) {
    activeBoardIndex.value = 0;
    return;
  }
  if (preferredBoardId != null) {
    const preferredIndex = nextBoards.findIndex((board) => board.id === preferredBoardId);
    if (preferredIndex >= 0) {
      activeBoardIndex.value = preferredIndex;
      return;
    }
  }
  if (activeBoardIndex.value >= nextBoards.length) {
    activeBoardIndex.value = nextBoards.length - 1;
  }
}

async function loadBoards() {
  if (!contextReady.value) {
    boards.value = [];
    loadError.value = "";
    return;
  }
  loading.value = true;
  try {
    const selectedBoardId = currentBoard.value?.id ?? null;
    const { data } = await axios.post("/production/storyboardBoard/list", {
      projectId: props.projectId,
      scriptId: props.scriptId,
    });
    const nextBoards = Array.isArray(data) ? data : [];
    if (!Array.isArray(data)) {
      loadError.value = "故事板接口返回异常，请刷新或查看后端日志。";
    } else {
      loadError.value = "";
    }
    boards.value = nextBoards;
    normalizeActiveBoardIndex(nextBoards, selectedBoardId);
    syncPromptDrafts(nextBoards);
  } catch (e) {
    loadError.value = (e as any)?.message || "故事板列表加载失败";
  } finally {
    loading.value = false;
  }
}

function changeActiveBoard(index: number) {
  activeBoardIndex.value = index;
}

function previewImages(images: string[]) {
  const nextImages = images.filter(Boolean);
  if (!nextImages.length) return;
  imagePreviewImages.value = nextImages;
  imagePreviewVisible.value = true;
}

function previewReferenceFrames(board: StoryboardBoard) {
  previewImages((board.videoReferenceFrames || []).map((item) => item.imageUrl));
}

function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement | null;
  if (img) img.style.display = "none";
}

function openScript(board: StoryboardBoard) {
  currentScript.value = board.shotScript || "";
  scriptVisible.value = true;
}

function previewVideo(video: StoryboardBoardVideo) {
  if (!video.src) return;
  currentVideoSrc.value = video.src;
  videoPreviewVisible.value = true;
}

function downloadVideo(video: StoryboardBoardVideo) {
  if (!video.src) return;
  window.open(video.src, "_blank");
}

async function copyPrompt() {
  if (!activePrompt.value) return;
  await navigator.clipboard.writeText(activePrompt.value);
  window.$message.success("已复制 prompt");
}

async function savePrompt(board: StoryboardBoard) {
  const prompt = promptDrafts.value[board.id] || "";
  if (!prompt.trim()) return window.$message.warning("prompt 为空，未保存");
  await axios.post("/production/storyboardBoard/updatePrompt", { boardId: board.id, prompt });
  window.$message.success("故事板 prompt 已保存");
  await loadBoards();
}

async function generatePrompt(board: StoryboardBoard) {
  if (!props.modelParmas.model || !props.modelParmas.duration || !props.modelParmas.resolution) {
    window.$message.warning("请选择模型、时长和分辨率");
    return;
  }
  if (promptGeneratingMap.value[board.id]) return;
  promptGeneratingMap.value[board.id] = true;
  try {
    const { data } = await axios.post(
      "/production/storyboardBoard/generatePrompt",
      {
        boardId: board.id,
        model: props.modelParmas.model,
        duration: props.modelParmas.duration,
        resolution: props.modelParmas.resolution,
        audio: props.modelParmas.audio,
      },
      { timeout: VIDEO_PROMPT_TIMEOUT },
    );
    promptDrafts.value[board.id] = data.prompt || "";
    window.$message.success(data.reused ? "已有视频任务正在生成，已读取当前 prompt" : "故事板视频 prompt 已生成");
    await loadBoards();
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板视频 prompt 生成失败");
  } finally {
    promptGeneratingMap.value[board.id] = false;
  }
}

function confirmGenerate(board: StoryboardBoard) {
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
      body: `将使用 ${props.modelParmas.model || "-"} 生成 ${formatBoardRange(board)}，时长 ${props.modelParmas.duration}s，分辨率 ${props.modelParmas.resolution || "-"}。当前提示词编辑框内容会作为实际请求 prompt。`,
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
  if (!props.modelParmas.model || !props.modelParmas.duration || !props.modelParmas.resolution) {
    window.$message.warning("请选择模型、时长和分辨率");
    return;
  }
  if (!(await confirmGenerate(board))) return;
  generatingBoardId.value = board.id;
  try {
    const { data } = await axios.post("/production/storyboardBoard/generateVideo", {
      boardId: board.id,
      model: props.modelParmas.model,
      duration: props.modelParmas.duration,
      resolution: props.modelParmas.resolution,
      audio: props.modelParmas.audio,
      prompt: promptDrafts.value[board.id] || undefined,
    });
    if (data?.prompt) promptDrafts.value[board.id] = data.prompt;
    window.$message.success("故事板视频已开始生成");
    await loadBoards();
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板视频生成失败");
  } finally {
    generatingBoardId.value = null;
  }
}

function confirmRegenerate(board: StoryboardBoard) {
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
  if (!canRegenerateBoard(board) || regeneratingBoardId.value === board.id) return;
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

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => void loadBoards(), 3000);
}

function stopPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

watch(
  () => [props.projectId, props.scriptId],
  () => {
    activeBoardIndex.value = 0;
    void loadBoards();
  },
  { immediate: true },
);

watch(running, (value) => {
  if (value) startPoll();
  else stopPoll();
});

onUnmounted(() => {
  stopPoll();
});
</script>

<style lang="scss" scoped>
.storyboardBoardMode {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 0 0 auto;
  min-height: 560px;
  height: calc(100vh - 190px);
  width: 100%;
  overflow: hidden;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--td-bg-color-page);

  .referencePanel {
    display: block;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 8px;
    background: var(--td-bg-color-container);
  }

  .referencePreview {
    display: none;
  }

  .modeHint {
    margin-bottom: 12px;
  }

  > .t-alert {
    flex: 0 0 auto;
    margin-bottom: 8px;
  }

  .emptyVisual {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--td-text-color-placeholder);
  }

  .rangeTag {
    position: absolute;
    left: 8px;
    top: 8px;
  }

  .referenceInfo {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .titleLine,
  .actionRow,
  .trackMenu .left,
  .trackMenu .right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .title {
    font-size: 16px;
    font-weight: 700;
    color: var(--td-text-color-primary);
  }

  .trackTitle {
    font-weight: 600;
  }

  .desc,
  .muted {
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .errorLine {
    color: var(--td-error-color);
    font-size: 12px;
  }

  .emptyHint {
    color: var(--td-warning-color);
    font-size: 12px;
  }

  .referenceStrip {
    display: none;
  }

  .referenceThumb {
    position: relative;
    flex: 0 0 64px;
    width: 64px;
    height: 64px;
    border-radius: 6px;
    overflow: hidden;
    cursor: zoom-in;
    background: var(--td-bg-color-secondarycontainer);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    span {
      position: absolute;
      left: 4px;
      bottom: 4px;
      padding: 1px 4px;
      border-radius: 4px;
      font-size: 11px;
      color: #fff;
      background: rgba(0, 0, 0, 0.65);
    }
  }

  .generate {
    display: flex;
    align-items: stretch;
    flex: 0 0 clamp(340px, 52vh, 460px);
    height: clamp(340px, 52vh, 460px);
    width: 100%;
    gap: 5px;

    .prompt,
    .video {
      width: 50%;
      height: 100%;
      min-height: 0;
    }

    .videoPrompt,
    .videoCard {
      width: 100%;
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;

      :deep(.t-card__body) {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
    }

    .promptData {
      width: 100%;
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .promptInput {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    .promptTextarea {
      width: 100%;
    }

    .referenceChips {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .referenceChip {
      cursor: pointer;
    }

    .simpleVideoPanel {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: hidden;
    }

    .boardPreview {
      position: relative;
      flex: 0 0 170px;
      border-radius: 8px;
      overflow: hidden;
      background: var(--td-bg-color-secondarycontainer);
      border: 1px solid var(--td-border-level-1-color);

      img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
      }
    }

    .boardPreviewEmpty {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--td-text-color-placeholder);
      font-size: 13px;
    }

    .previewTag {
      position: absolute;
      left: 8px;
      top: 8px;
    }

    .historyHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: 0 0 auto;
      font-size: 13px;
      color: var(--td-text-color-secondary);
    }

    .simpleVideoList {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      gap: 8px;
    }

    .simpleVideoItem {
      position: relative;
      width: 132px;
      height: 92px;
      border-radius: 6px;
      overflow: hidden;
      background: var(--td-bg-color-secondarycontainer);
      border: 1px solid var(--td-border-level-1-color);

      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
    }

    .simpleVideoPlaceholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--td-text-color-placeholder);
      font-size: 12px;
    }

    .simpleVideoActions {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: center;
      gap: 4px;
      padding: 4px;
      background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.72));
    }

    .videoStateTag {
      position: absolute;
      left: 6px;
      top: 6px;
    }

    .emptyVideoHistory {
      flex: 1;
      min-height: 96px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--td-text-color-placeholder);
      border: 1px dashed var(--td-border-level-1-color);
      border-radius: 6px;
      background: var(--td-bg-color-secondarycontainer);
      font-size: 13px;
    }
  }

  .history {
    height: 100%;

    .titleBox {
      gap: 6px;
      margin-bottom: 8px;

      .title {
        font-size: 13px;
        color: var(--td-text-color-secondary);
      }
    }

    .historyItemBox {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .historyItem {
      position: relative;
      width: 130px;
      height: 90px;
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      border: 2px solid transparent;
      background: var(--td-bg-color-secondarycontainer);

      &.generating,
      &.failed {
        cursor: default;
      }

      .videoCover,
      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }

    .videoPlaceholder {
      width: 100%;
      height: 100%;
      color: var(--td-text-color-placeholder);
    }

    .loadingOverlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      gap: 4px;

      .loadingText {
        font-size: 11px;
        color: #fff;
      }
    }

    .stateTag {
      position: absolute;
      bottom: 4px;
      left: 4px;
    }

    .download,
    .playBtn {
      position: absolute;
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      cursor: pointer;
    }

    .download {
      bottom: 4px;
      left: 4px;
    }

    .playBtn {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 32px;
      height: 32px;
    }

    .historyItem:hover {
      .download,
      .playBtn {
        display: flex;
      }
    }
  }

  .track {
    flex: 0 0 auto;
    width: 100%;
  }

  .videoTrack {
    flex: 0 0 204px;
    height: 204px;
    max-height: 204px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    contain: layout style;

    :deep(.t-card__body) {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .trackMenu {
      margin-bottom: 10px;
      contain: layout style;

      .selectedCount {
        margin-left: 8px;
        color: var(--td-text-color-secondary);
        font-size: 12px;
      }

      .right {
        gap: 8px;
      }
    }

    .itemBox {
      height: 150px;
      max-height: 150px;
      flex: 1;
      min-height: 0;
      width: 100%;
      display: flex;
      align-items: stretch;
      overflow-x: auto;
      overflow-y: hidden;
      gap: 10px;
      padding-bottom: 6px;
      box-sizing: border-box;
      contain: layout style;

      &::-webkit-scrollbar {
        height: 6px;
      }

      &::-webkit-scrollbar-thumb {
        background: #696969;
        border-radius: 3px;
      }
    }

    .item {
      position: relative;
      flex-shrink: 0;
      width: 200px;
      height: 100%;
      max-height: 144px;
      border: 1px solid var(--td-gray-color-3);
      border-radius: 8px;
      overflow: hidden;
      box-sizing: border-box;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--td-bg-color-secondarycontainer);
      contain: layout style;

      &.active {
        border-color: var(--td-brand-color);
        border-width: 2px;
        box-shadow: none;
        background: rgba(var(--td-brand-color-rgb, 0, 82, 217), 0.05);
      }

      &:hover .regenBtn,
      &.active .regenBtn {
        display: flex;
      }
    }

    .thumbGroup {
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      display: flex;

      .thumb {
        flex: 1;
        width: 100%;
        min-width: 0;
        height: 100%;
        max-height: 100%;
        object-fit: cover;
        display: block;
      }
    }

    .emptyTrack {
      color: var(--td-text-color-placeholder);
      font-size: 12px;
    }

    .indexTag {
      position: absolute;
      bottom: 4px;
      left: 4px;
      z-index: 2;
    }

    .selectTag {
      position: absolute;
      bottom: 4px;
      right: 4px;
      z-index: 2;
    }

    .stateTag {
      position: absolute;
      top: 4px;
      left: 4px;
      z-index: 2;
    }

    .regenBtn {
      position: absolute;
      top: 4px;
      right: 4px;
      z-index: 2;
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 50%;
      color: #fff;
      background: rgba(0, 0, 0, 0.5);
      cursor: pointer;
      font-size: 12px;

      &:hover {
        background: rgba(0, 0, 0, 0.8);
      }

      &:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
    }
  }

  .videoPreview {
    width: 100%;
    max-height: 70vh;
    border-radius: 8px;
    background: #000;
  }

  .scriptText {
    max-height: 70vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    padding: 12px;
    border-radius: 8px;
    background: var(--td-bg-color-secondarycontainer);
  }

  .buttonRow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .promptEditorPlain {
    box-sizing: border-box;
    flex: 1 1 auto;
    min-height: 220px;
    width: 100%;
    padding: 12px;
    border: 1px solid #d8e0ec;
    border-radius: 10px;
    resize: none;
    outline: none;
    color: #111827;
    background: #fbfdff;
    font-size: 13px;
    line-height: 1.65;

    &:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
    }
  }

  .referenceChips {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .refChip {
    padding: 3px 8px;
    border: 1px solid #bfdbfe;
    border-radius: 999px;
    color: #1d4ed8;
    background: #eff6ff;
    cursor: pointer;
  }

  .videoHistory {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }

  .historyTitle {
    flex: 0 0 auto;
    color: #475569;
    font-size: 13px;
    font-weight: 700;
  }

  .videoListPlain {
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
    gap: 8px;
    overflow: auto;
  }

  .videoItemPlain {
    position: relative;
    height: 96px;
    border: 1px solid #d8e0ec;
    border-radius: 9px;
    overflow: hidden;
    background: #e2e8f0;

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    &.failed {
      border-color: #fecaca;
    }
  }

  .videoPlaceholderPlain,
  .emptyVideoHistory {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 12px;
  }

  .videoPlaceholderPlain {
    width: 100%;
    height: 100%;
  }

  .emptyVideoHistory {
    flex: 1 1 auto;
    border: 1px dashed #cbd5e1;
    border-radius: 10px;
  }

  .videoActionsPlain {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    gap: 4px;
    padding: 4px;
    background: linear-gradient(180deg, transparent, rgba(15, 23, 42, 0.76));

    button {
      border: none;
      background: transparent;
      color: #fff;
      cursor: pointer;

      &:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
    }
  }

  .errorTip {
    position: absolute;
    left: 6px;
    top: 6px;
    right: 6px;
    padding: 2px 5px;
    border-radius: 6px;
    color: #991b1b;
    background: rgba(254, 226, 226, 0.95);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .warningText {
    color: #92400e;
    font-size: 12px;
  }

  .dangerText {
    color: #991b1b;
    font-size: 12px;
  }

  .muted {
    color: var(--td-text-color-secondary);
  }

  .promptEditorPlain {
    border-color: var(--td-border-level-1-color);
    border-radius: 6px;
    color: var(--td-text-color-primary);
    background: var(--td-bg-color-container);
  }

  .promptEditorPlain:focus {
    border-color: var(--td-brand-color);
    box-shadow: none;
  }

  .refChip {
    border-color: var(--td-brand-color-light);
    color: var(--td-brand-color);
    background: var(--td-brand-color-light);
  }

  .emptyVideoHistory,
  .videoItemPlain {
    border-color: var(--td-border-level-1-color);
    border-radius: 6px;
    background: var(--td-bg-color-secondarycontainer);
  }

  .generate {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
  }

  .generate .videoPrompt {
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    :deep(.t-card__body) {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
  }

  .storyboardMeta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  .promptActions {
    margin-top: 8px;
  }

  .videoHistory {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  }

  .videoListPlain {
    flex: 1;
    min-height: 0;
  }

  .promptInput {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 6px;
    background: var(--td-bg-color-container);
  }

  .history {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;

    .titleBox {
      flex: 0 0 auto;
      gap: 6px;
      margin-bottom: 8px;

      .title {
        font-size: 13px;
        font-weight: 400;
        color: var(--td-text-color-secondary);
      }
    }

    .historyItemBox {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-wrap: wrap;
      align-content: flex-start;
      gap: 8px;
      overflow: auto;
    }

    .historyItem {
      position: relative;
      width: 130px;
      height: 90px;
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      border: 2px solid transparent;
      background: var(--td-bg-color-secondarycontainer);

      &.generating,
      &.failed {
        cursor: default;
      }

      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      &:hover {
        .download,
        .playBtn {
          display: flex;
        }
      }
    }

    .videoPlaceholder {
      width: 100%;
      height: 100%;
      color: var(--td-text-color-placeholder);
      font-size: 12px;
    }

    .loadingOverlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      gap: 4px;

      .loadingText {
        font-size: 11px;
        color: #fff;
      }
    }

    .stateTag {
      position: absolute;
      bottom: 4px;
      left: 4px;
    }

    .download,
    .playBtn {
      position: absolute;
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      cursor: pointer;
    }

    .download {
      bottom: 4px;
      left: 4px;
    }

    .playBtn {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 32px;
      height: 32px;
      border-radius: 50%;
    }

    .emptyHistory {
      width: 100%;
      min-height: 96px;
      color: var(--td-text-color-placeholder);
      border: 1px dashed var(--td-border-level-1-color);
      border-radius: 6px;
      background: var(--td-bg-color-secondarycontainer);
      font-size: 13px;
    }
  }

  @media (max-width: 980px) {
    height: auto;
    min-height: 780px;
    overflow-y: auto;

  }
}
</style>
