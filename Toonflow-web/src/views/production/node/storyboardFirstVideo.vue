<template>
  <t-card class="storyboardFirstNode">
    <Handle :id="handleIds.target" type="target" :position="Position.Left" />
    <div class="titleBar dragHandle">
      <div>
        <div class="title">故事板先行 · 故事板转视频</div>
        <div class="subTitle">单图故事板生成视频，不写入主视频工作台</div>
      </div>
      <t-button size="small" variant="outline" :loading="loading" @click="refresh">刷新</t-button>
    </div>

    <div class="videoControls">
      <t-select v-model="selectedModel" size="small" class="modelSelect" filterable :loading="modelLoading" placeholder="选择单图视频模型" @change="applyModelDefaults">
        <t-option v-for="item in singleImageVideoModels" :key="item.modelId" :value="item.modelId" :label="item.label" />
      </t-select>
      <t-select v-model="duration" size="small" class="smallSelect" :disabled="!durationOptions.length">
        <t-option v-for="item in durationOptions" :key="item" :value="item" :label="`${item}s`" />
      </t-select>
      <t-select v-model="resolution" size="small" class="smallSelect" :disabled="!resolutionOptions.length">
        <t-option v-for="item in resolutionOptions" :key="item" :value="item" :label="item" />
      </t-select>
      <t-switch v-model="audio" size="small" :disabled="selectedModelDetail?.audio === false" />
      <span class="audioLabel">音频</span>
    </div>

    <t-alert v-if="image?.stale" theme="warning" message="故事板图片已过期，请先重新生成图片" />
    <t-alert v-if="latestVideo?.stale" theme="warning" message="该视频基于旧故事板图片生成" />
    <t-alert v-if="latestVideo?.errorReason" theme="error" :message="latestVideo.errorReason" />

    <div class="meta">
      图片：{{ image?.state || "未生成" }} · 视频：{{ latestVideo?.state || "未生成" }} · {{ latestVideo?.duration || duration }}s
    </div>

    <div class="controls">
      <t-button size="small" theme="primary" :loading="actionLoading" :disabled="!canGenerateVideo" @click="generateVideoFromImage">故事板转视频</t-button>
      <t-button size="small" variant="outline" :disabled="!latestVideo?.src" @click="previewVideo">预览视频</t-button>
      <t-button size="small" variant="outline" :disabled="!latestVideo?.src" @click="openUrl(latestVideo?.src || '')">下载视频</t-button>
    </div>

    <div v-if="videoHistory.length" class="history">
      <div v-for="item in videoHistory.slice(0, 3)" :key="item.id" class="historyItem" :class="{ stale: item.stale }">
        #{{ item.id }} · {{ item.state }} · {{ item.duration }}s · {{ item.resolution }}
      </div>
    </div>

    <t-dialog v-model:visible="videoPreviewVisible" header="故事板先行视频预览" width="760px" :footer="false">
      <video v-if="currentVideoSrc" class="videoPreview" :src="currentVideoSrc" controls autoplay />
    </t-dialog>
  </t-card>
</template>

<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { DialogPlugin } from "tdesign-vue-next";
import axios from "@/utils/axios";
import { useStoryboardFirstWorkflow } from "../composables/useStoryboardFirstWorkflow";

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
  id: string;
  projectId?: number | null;
  scriptId?: number | null;
  projectVideoModel?: string | null;
  handleIds: {
    target: string;
  };
}>();

const { image, latestVideo, videoHistory, loading, actionLoading, refresh, generateVideo } = useStoryboardFirstWorkflow(
  computed(() => props.projectId),
  computed(() => props.scriptId),
);
const selectedModel = ref("");
const duration = ref(10);
const resolution = ref("");
const audio = ref(false);
const modelLoading = ref(false);
const singleImageVideoModels = ref<SingleImageVideoModel[]>([]);
const videoPreviewVisible = ref(false);
const currentVideoSrc = ref("");

const selectedModelDetail = computed(() => singleImageVideoModels.value.find((item) => item.modelId === selectedModel.value)?.detail);
const durationOptions = computed(() => {
  const durations = new Set<number>();
  selectedModelDetail.value?.durationResolutionMap?.forEach((item) => item.duration?.forEach((value) => durations.add(Number(value))));
  return Array.from(durations).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
});
const resolutionOptions = computed(() => {
  const resolutions = new Set<string>();
  selectedModelDetail.value?.durationResolutionMap?.forEach((item) => {
    const durations = item.duration?.map((value) => Number(value)) ?? [];
    if (!durations.length || durations.includes(duration.value)) item.resolution?.forEach((value) => resolutions.add(value));
  });
  return Array.from(resolutions);
});
const canGenerateVideo = computed(() => !!image.value?.id && image.value.state === "已完成" && !image.value.stale && !!selectedModel.value && !!duration.value && !!resolution.value);

function modeSupportsSingleImage(mode: unknown) {
  if (!Array.isArray(mode)) return false;
  return mode.some((item) => item === "singleImage" || (Array.isArray(item) && item.includes("singleImage")));
}

function isGrokVideoModel(modelId: string, detail: VideoModelDetail) {
  const value = `${modelId} ${detail.name} ${detail.modelName}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video") || (value.includes("grok") && value.includes("imagine") && value.includes("video"));
}

function isGrokImagineVideo15PreviewModel(modelId: string, detail: VideoModelDetail) {
  const value = `${modelId} ${detail.name} ${detail.modelName}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video-1.5-preview") || value.includes("grokimaginevideo1.5preview");
}

function normalizeModelDetail(modelId: string, detail: VideoModelDetail): VideoModelDetail {
  if (!isGrokVideoModel(modelId, detail)) return detail;
  const durations = isGrokImagineVideo15PreviewModel(modelId, detail) ? [6, 10, 15] : [6, 10];
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
  if (durations.length && !durations.includes(duration.value)) duration.value = durations.includes(10) ? 10 : durations[0];
  const resolutions = resolutionOptions.value;
  if (resolutions.length && !resolutions.includes(resolution.value)) resolution.value = resolutions[0];
  if (selectedModelDetail.value?.audio === false) audio.value = false;
}

async function confirmGenerate() {
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
      header: "确认生成故事板先行视频",
      body: `将使用 ${selectedModel.value || "-"} 读取当前故事板图片生成 ${duration.value}s 视频，分辨率 ${resolution.value || "-"}。视频不会进入主视频工作台。`,
      confirmBtn: "开始生成",
      cancelBtn: "取消",
      closeOnOverlayClick: false,
      closeOnEscKeydown: false,
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}

async function generateVideoFromImage() {
  if (!image.value?.id || !(await confirmGenerate())) return;
  try {
    await generateVideo({
      firstImageId: image.value.id,
      model: selectedModel.value,
      duration: duration.value,
      resolution: resolution.value,
      audio: audio.value,
    });
    window.$message.success("故事板先行视频已开始生成");
  } catch (e) {
    window.$message.error((e as any)?.message || "视频生成失败");
  }
}

function previewVideo() {
  if (!latestVideo.value?.src) return;
  currentVideoSrc.value = latestVideo.value.src;
  videoPreviewVisible.value = true;
}

function openUrl(url: string) {
  if (url) window.open(url, "_blank");
}

watch([durationOptions, resolutionOptions], () => applyModelDefaults());

onMounted(() => {
  void loadVideoModels();
});
</script>

<style scoped lang="scss">
.storyboardFirstNode {
  width: 440px;

  .titleBar {
    cursor: grab;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .title {
    width: fit-content;
    padding: 5px 10px;
    border-radius: 8px 0;
    color: #fff;
    background: #3b2a17;
    font-size: 16px;
    font-weight: 700;
  }

  .subTitle,
  .meta,
  .audioLabel {
    margin-top: 6px;
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .videoControls,
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 12px 0;
  }

  .modelSelect {
    width: 300px;
  }

  .smallSelect {
    width: 108px;
  }

  .history {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .historyItem {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--td-bg-color-container-hover, #f5f5f5);
    font-size: 12px;
  }

  .historyItem.stale {
    color: var(--td-warning-color);
  }

  .videoPreview {
    width: 100%;
    max-height: 70vh;
    background: #000;
  }
}
</style>
