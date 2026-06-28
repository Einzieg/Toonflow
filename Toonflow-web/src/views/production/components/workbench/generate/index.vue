<template>
  <div class="index fc" :class="{ storyboardModeLayout: isStoryboardBoardMode }">
    <div v-if="!isStoryboardBoardMode" class="referenceImage">
      <div class="uploadBtn">
        <imageSelect :mode="modelParmas.mode as VideoMode" v-model="imageList" :storyboard-list="storyboardList" @refresh="getGenerateData" />
      </div>
    </div>
    <div class="modelSelect">
      <modeMenu
        v-model="modelParmas"
        :modeOptions="modeOptions"
        :trackId="currentTrack?.id"
        :modeList="modeList"
        @modeChange="modeChange"
        @durationChange="handleDurationChange"
        @modelChange="handleModelChange" />
    </div>
    <div v-if="isStoryboardBoardMode" class="storyboardModeHost">
      <storyboardBoardMode
        :project-id="currentProjectId"
        :script-id="currentScriptId"
        :model-parmas="modelParmas"
      />
    </div>
    <div v-else class="generate ac">
      <div class="prompt" v-if="currentTrack">
        <t-card :title="'#' + (activeTrackIndex + 1) + $t('workbench.generate.generateText')" header-bordered class="videoPrompt">
          <template #actions>
            <t-button size="small" variant="outline" @click="togglePromptAgent">
              {{ promptAgentVisible ? "收起助手" : "提示词助手" }}
            </t-button>
            <t-button size="small" class="genTextbtn" :loading="activeTrackGenTextLoading" @click="genText">
              {{ $t("workbench.generate.generateText") }}
            </t-button>
          </template>
          <div class="promptData fc">
            <div class="promptInput" @focusout="handlePromptBlur">
              <promptEditor v-model="currentTrack.prompt" :references="references" :placeholder="$t('workbench.generate.promptPlaceholder')" />
            </div>
            <div v-if="promptAgentVisible" class="promptAgent">
              <div class="promptAgentHeader">
                <span>视频提示词修改 Agent</span>
                <span class="promptAgentHint">对话会直接改写并保存当前轨道提示词</span>
              </div>
              <div class="promptAgentMessages">
                <div v-if="!currentPromptAgentMessages.length" class="promptAgentEmpty">
                  例如：强化角色动作演进；补齐台词语气语速；压缩到 Grok 更容易理解的英文提示词。
                </div>
                <div
                  v-for="(msg, index) in currentPromptAgentMessages"
                  :key="`${msg.role}-${index}`"
                  class="promptAgentMessage"
                  :class="msg.role">
                  <span class="messageRole">{{ msg.role === "user" ? "我" : "Agent" }}</span>
                  <span class="messageContent">{{ msg.content }}</span>
                </div>
              </div>
              <div class="promptAgentInputRow">
                <t-textarea
                  v-model="promptAgentInput"
                  class="promptAgentInput"
                  placeholder="输入修改要求，例如：让台词更紧凑，保留所有中文对白，镜头动作更连续"
                  :autosize="{ minRows: 2, maxRows: 4 }"
                  @keydown.ctrl.enter.prevent="sendPromptAgentMessage" />
                <t-button theme="primary" :loading="promptAgentLoading" :disabled="!promptAgentInput.trim()" @click="sendPromptAgentMessage">
                  发送并改写
                </t-button>
              </div>
            </div>
          </div>
        </t-card>
      </div>
      <div class="video">
        <videoCard
          v-if="currentTrack"
          :active-track-index="activeTrackIndex"
          :generating="activeTrackGenerating"
          v-model:current-track="currentTrack"
          @refresh="getGenerateData"
          @generate="generateVideo" />
      </div>
    </div>
    <div v-if="!isStoryboardBoardMode" class="track">
      <newTrack
        v-model:activeTrackIndex="activeTrackIndex"
        v-model:genTextLoadingMap="genTextLoadingMap"
        v-model:generatingMap="generatingMap"
        v-model="trackList"
        :image-list="imageList"
        @change="trackChange"
        :modelParmas="modelParmas"
        :clampDuration="clampDuration"
        @getData="getGenerateData" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import newTrack from "./components/track.vue";
import imageSelect from "./components/imageSelect.vue";
import modeMenu from "./components/modeMenu.vue";
import videoCard from "./components/video.vue";
import storyboardBoardMode from "./components/storyboardBoardMode.vue";
import "@/views/production/components/workbench/type/type";
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import promptEditor from "@/components/promptEditor.vue";
import imageListCacheStore from "@/stores/imageListCache";

const VIDEO_PROMPT_TIMEOUT = 5 * 60 * 1000;
const GROK_VIDEO_SUPPORTED_DURATIONS = [4, 5, 6, 7, 8, 9, 10] as const;
const GROK_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const STORYBOARD_BOARD_MODE = "storyboardBoard";

const { project } = storeToRefs(projectStore());
const episodesId = inject<Ref<number>>("episodesId")!;
const activeTrackIndex = ref(0);
const cacheStore = imageListCacheStore();
const { getCache, setCache, removeCache, syncCacheFromTrackList, warmUpUrls } = cacheStore;
const { urlMap } = storeToRefs(cacheStore);

const modeOptions = ref<VideoModel>({
  name: "",
  modelName: "",
  durationResolutionMap: [],
  audio: false,
  type: "video",
  mode: [],
}); // 当前模型配置

const trackList = ref<TrackItem[]>([]); // 轨道列表
const generatingMap = ref<Record<number, boolean>>({}); // trackId -> 是否正在提交生成请求
let generateConfirmDialogOpen = false;
const referenceSaveSeqMap = ref<Record<number, number>>({});
const projectModelInitializedFor = ref<number | string | null>(null);
const userSelectedModel = ref(false);

type PromptAgentMessage = {
  role: "user" | "assistant";
  content: string;
};

const promptAgentVisible = ref(false);
const promptAgentInput = ref("");
const promptAgentLoading = ref(false);
const promptAgentMessagesMap = ref<Record<number, PromptAgentMessage[]>>({});

const modelParmas = ref<ModelSetting>({
  mode: "",
  model: "",
  resolution: "480p",
  duration: 8,
  audio: false,
});

const storyboardList = ref<StoryboardItem[]>([]); // 分镜列表
const isStoryboardBoardMode = computed(() => modelParmas.value.mode === STORYBOARD_BOARD_MODE);
const currentProjectId = computed(() => (project.value?.id != null ? Number(project.value.id) : undefined));
const currentScriptId = computed(() => (episodesId.value != null ? Number(episodesId.value) : undefined));
const isEffectiveSingleImageMode = computed(
  () => modelParmas.value.mode === "singleImage" || isGrokImagineVideo15PreviewModel(modelParmas.value.model, modeOptions.value.modelName),
);

const FRAME_MODES = ["startEndRequired", "endFrameOptional", "startFrameOptional"];

/** 排序优先级：单图模式优先显示分镜图；多参模式仍优先资产参考。 */
function getImageItemPriority(item: UploadItem): number {
  if (isEffectiveSingleImageMode.value && item.sources === "storyboard" && item.src) return 0;
  if (isVolcengineSeedance2Model(modelParmas.value.model, modeOptions.value.modelName) && item.volcengineAssetUri) return 0;
  if (item.src) return item.sources === "assets" ? 0 : 1;
  return 2;
}

function isUsableReferenceItem(item: UploadItem | TrackMedia | undefined) {
  const useVolcengineAssetUri = isVolcengineSeedance2Model(modelParmas.value.model, modeOptions.value.modelName);
  if (useVolcengineAssetUri && item?.sources === "assets" && item.id) return true;
  return Boolean(item?.src || (useVolcengineAssetUri && item?.volcengineAssetUri));
}

function normalizeSingleReferenceList(items: (UploadItem | TrackMedia)[] | undefined): UploadItem[] {
  const filtered = (items ?? []).filter((item) => isUsableReferenceItem(item) && item.id) as UploadItem[];
  const storyboardItem = filtered.find((item) => item.sources === "storyboard" && item.src);
  const selected = storyboardItem ?? filtered[0];
  return selected ? [selected] : [];
}

function getCurrentTrackUploadData() {
  if (modelParmas.value.mode === "text") return [];
  const filtered = imageList.value.filter((item) => isUsableReferenceItem(item) && item.id);
  if (FRAME_MODES.includes(modelParmas.value.mode)) return filtered.slice(0, 2).map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
  if (isEffectiveSingleImageMode.value) {
    return normalizeSingleReferenceList(filtered).map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
  }
  return filtered.map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
}

function serializeTrackReferences(items: (UploadItem | TrackMedia)[]) {
  return items
    .filter((item) => item?.id != null && (item.sources === "storyboard" || item.sources === "assets"))
    .map((item) => ({
      id: Number(item.id),
      sources: item.sources === "assets" ? "assets" : "storyboard",
      referenceImageKind: item.sources === "storyboard" && (item.referenceImageKind === "grid" || item.referenceImageKind === "tailFrame")
        ? item.referenceImageKind
        : item.sources === "storyboard"
          ? "storyboard"
          : undefined,
    }));
}

async function persistTrackReferences(trackId: number, items: (UploadItem | TrackMedia)[]) {
  const projectId = Number(project.value?.id);
  const scriptId = Number(episodesId.value);
  if (!Number.isFinite(projectId) || !Number.isFinite(scriptId) || !Number.isFinite(trackId)) return;

  const seq = (referenceSaveSeqMap.value[trackId] ?? 0) + 1;
  referenceSaveSeqMap.value = { ...referenceSaveSeqMap.value, [trackId]: seq };
  try {
    await axios.post("/production/workbench/updateTrackReferences", {
      projectId,
      scriptId,
      trackId,
      items: serializeTrackReferences(items),
    });
    if (referenceSaveSeqMap.value[trackId] !== seq) return;
    const targetTrack = trackList.value.find((item) => item.id === trackId);
    if (targetTrack) targetTrack.referenceMediaLocked = true;
  } catch (e) {
    window.$message.error((e as Error)?.message ?? "参考图固定失败");
  }
}

const effectiveReferenceItems = computed(() => {
  if (!isEffectiveSingleImageMode.value) return imageList.value;
  return normalizeSingleReferenceList(imageList.value);
});

function getModelDisplayName() {
  const [, modelName] = String(modelParmas.value.model || "").split(/:(.+)/);
  return modelName || modeOptions.value.modelName || modelParmas.value.model || "-";
}

function getCurrentGenerateDuration() {
  return clampDuration(Number(modelParmas.value.duration || currentTrack.value?.duration));
}

function getCurrentTrackDurationConfirmText(requestDuration: number) {
  const sourceDuration = (currentTrack.value?.medias ?? [])
    .filter((item) => item.sources === "storyboard")
    .reduce((sum, item) => {
      const duration = Number(item.duration);
      return sum + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    }, 0);
  if (!sourceDuration) return "";

  const sourceText = Number(sourceDuration.toFixed(1));
  if (Number.isFinite(requestDuration) && requestDuration > 0 && Math.abs(requestDuration - sourceDuration) > 0.01) {
    return `轨道时长：请求 ${requestDuration}s，源分镜累计 ${sourceText}s；当前模型会按请求时长适配，不反写源分镜时长。`;
  }
  return `轨道时长：请求 ${requestDuration}s，源分镜累计 ${sourceText}s。`;
}

function confirmGenerateVideo(trackIndex: number, referenceCount: number, duration: number) {
  if (generateConfirmDialogOpen) return Promise.resolve(false);
  generateConfirmDialogOpen = true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let dlg: ReturnType<typeof DialogPlugin.confirm>;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      generateConfirmDialogOpen = false;
      dlg?.destroy();
      resolve(confirmed);
    };

    const durationText = getCurrentTrackDurationConfirmText(duration);
    dlg = DialogPlugin.confirm({
      header: $t("workbench.generate.generateConfirm"),
      body: [
        $t("workbench.generate.generateConfirmBody"),
        $t("workbench.generate.generateConfirmTrack", { index: trackIndex + 1 }),
        $t("workbench.generate.generateConfirmMeta", {
          model: getModelDisplayName(),
          duration,
          resolution: modelParmas.value.resolution,
          referenceCount,
        }),
        durationText,
        $t("workbench.generate.generateConfirmCostHint"),
      ].filter(Boolean).join("\n"),
      confirmBtn: $t("workbench.generate.confirmGenerate"),
      cancelBtn: $t("workbench.generate.cancelGenerate"),
      closeBtn: false,
      closeOnEscKeydown: false,
      closeOnOverlayClick: false,
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}

const imageList = computed({
  get(): UploadItem[] {
    // 触发对 urlMap 的依赖追踪，当 warmUpUrls 更新 urlMap 后自动重新计算
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    urlMap.value;
    const trackId = currentTrack.value?.id;
    const pid = project.value?.id;
    const sid = episodesId.value;
    // 优先从缓存读取
    if (pid != null && sid != null && trackId != null) {
      const cached = getCache(pid, sid, trackId);
      if (cached?.length) {
        cached.sort((a, b) => getImageItemPriority(a) - getImageItemPriority(b));
        return isEffectiveSingleImageMode.value ? normalizeSingleReferenceList(cached) : cached;
      }
    }
    const medias = currentTrack.value?.medias;
    if (!medias?.length) return [];
    (medias as UploadItem[]).sort((a, b) => getImageItemPriority(a) - getImageItemPriority(b));
    return isEffectiveSingleImageMode.value ? normalizeSingleReferenceList(medias as UploadItem[]) : (medias as UploadItem[]);
  },
  set(val: UploadItem[]) {
    if (currentTrack.value) {
      const nextVal = isEffectiveSingleImageMode.value ? normalizeSingleReferenceList(val) : val;
      currentTrack.value.medias = nextVal as any;
      // 同步写入缓存
      const pid = project.value?.id;
      const sid = episodesId.value;
      const trackId = currentTrack.value.id;
      if (pid != null && sid != null && trackId != null) {
        setCache(pid, sid, trackId, nextVal);
      }
      persistTrackReferences(currentTrack.value.id, nextVal);
    }
  },
});

function modeChange(newVal: string) {
  if (newVal == modelParmas.value.mode) return;
  if (newVal) {
    modelParmas.value.mode = newVal;
  }
}
const modeList = computed(() => {
  const modeLabelMap: Record<string, string> = {
    singleImage: "单图",
    startEndRequired: "首尾帧",
    endFrameOptional: "尾帧可选",
    startFrameOptional: "首帧可选",
    text: "文本生视频",
    videoReference: "视频",
    imageReference: "图片",
    audioReference: "音频",
    textReference: "文本",
    storyboardBoard: "故事板模式",
  };
  function parseRefLabel(m: string): string {
    const match = m.match(/^(videoReference|imageReference|audioReference|textReference):(\d+)$/);
    if (match) {
      const base = modeLabelMap[match[1]] || match[1];
      return `${base} ×${match[2]}`;
    }
    return modeLabelMap[m] || m;
  }
  const modelModes = modeOptions.value.mode
    ? modeOptions.value.mode.map((mode) =>
        Array.isArray(mode)
          ? { value: JSON.stringify(mode), label: mode.map((m) => parseRefLabel(m)).join(" + ") + "参考" }
          : { value: mode, label: modeLabelMap[mode] || mode },
      )
    : [];
  return [...modelModes, { value: STORYBOARD_BOARD_MODE, label: modeLabelMap[STORYBOARD_BOARD_MODE] }];
});
const currentTrack = computed({
  get() {
    return trackList.value[activeTrackIndex.value];
  },
  set(val) {
    trackList.value[activeTrackIndex.value] = val;
  },
});
const currentPromptAgentMessages = computed(() => {
  const trackId = currentTrack.value?.id;
  return trackId != null ? promptAgentMessagesMap.value[trackId] ?? [] : [];
});
const activeTrackGenerating = computed(() => {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  return trackId != null ? !!generatingMap.value[trackId] : false;
});
/** 当前轨道是否正在生成提示词 */
const activeTrackGenTextLoading = computed(() => {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  return trackId != null ? !!genTextLoadingMap.value[trackId] : false;
});

function isSeedance2Model(model?: string | null, displayName?: string | null) {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("seedance") && (value.includes("seedance-2-0") || value.includes("seedance-2.0") || value.includes("seedance2.0"));
}

function isVolcengineSeedance2Model(model?: string | null, displayName?: string | null) {
  const [vendorId] = String(model || "").split(/:(.+)/);
  return vendorId === "volcengine" && isSeedance2Model(model, displayName);
}

function isGrokImagineVideoModel(model?: string | null, displayName?: string | null) {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video") || (value.includes("grok") && value.includes("imagine") && value.includes("video"));
}

function isGrokImagineVideo15PreviewModel(model?: string | null, displayName?: string | null) {
  const value = `${model ?? ""} ${displayName ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video-1.5-preview") || value.includes("grokimaginevideo1.5preview");
}

function getGrokVideoSupportedDurations(model?: string | null, displayName?: string | null) {
  if (isGrokImagineVideo15PreviewModel(model, displayName)) {
    return [...GROK_VIDEO_15_PREVIEW_SUPPORTED_DURATIONS];
  }
  return [...GROK_VIDEO_SUPPORTED_DURATIONS];
}

function resolveGrokDuration(duration?: number | string | null) {
  const durations = getGrokVideoSupportedDurations(modelParmas.value.model, modeOptions.value.modelName);
  const value = Number(duration);
  if (!Number.isFinite(value) || value <= 0) return durations[0];
  const clamped = Math.max(Math.min(...durations), Math.min(value, Math.max(...durations)));
  return durations.reduce((best, current) => (Math.abs(current - clamped) <= Math.abs(best - clamped) ? current : best), durations[0]);
}

function normalizeModeOptions(data: VideoModel): VideoModel {
  if (isGrokImagineVideoModel(modelParmas.value.model, data.modelName)) {
    const durations = getGrokVideoSupportedDurations(modelParmas.value.model, data.modelName);
    return {
      ...data,
      mode: isGrokImagineVideo15PreviewModel(modelParmas.value.model, data.modelName) ? ["singleImage"] : data.mode,
      durationResolutionMap: data.durationResolutionMap?.map((item) => ({
        ...item,
        duration: durations,
      })) ?? [{ duration: durations, resolution: [] }],
    };
  }
  return data;
}

/** 将时长限制在模型支持的范围内 */
function clampDuration(trackDuration: number): number {
  if (isGrokImagineVideoModel(modelParmas.value.model, modeOptions.value.modelName)) {
    return resolveGrokDuration(trackDuration || modelParmas.value.duration);
  }
  const drMap = modeOptions.value?.durationResolutionMap;
  if (Array.isArray(drMap) && drMap.length > 0 && drMap[0].duration?.length) {
    const durations = drMap[0].duration;
    const value = Number.isFinite(Number(trackDuration)) && Number(trackDuration) > 0 ? Number(trackDuration) : modelParmas.value.duration;
    return Math.max(Math.min(...durations), Math.min(value, Math.max(...durations)));
  }
  return trackDuration;
}
watch(
  () => modelParmas.value.model,
  (val) => {
    if (!val) {
      modeOptions.value = {
        name: "",
        modelName: "",
        durationResolutionMap: [],
        audio: false,
        type: "video",
        mode: [],
      };
      if (modelParmas.value.mode !== STORYBOARD_BOARD_MODE) modelParmas.value.mode = "";
      return;
    }
    axios.post("/modelSelect/getModelDetail", { modelId: val }).then(({ data }) => {
      modeOptions.value = normalizeModeOptions(data);
      modelParmas.value.audio = data.audio !== false && data.audio !== "false";
      const drMap = modeOptions.value.durationResolutionMap;
      if (Array.isArray(drMap) && drMap.length > 0) {
        if (drMap[0].resolution?.length) modelParmas.value.resolution = drMap[0].resolution[0];
        if (drMap[0].duration?.length) modelParmas.value.duration = clampDuration(modelParmas.value.duration);
      }

      const currentParsed = parseMode(modelParmas.value.mode);
      const modeMatched =
        modelParmas.value.mode === STORYBOARD_BOARD_MODE ||
        data.mode.some((m: VideoMode) => {
          if (Array.isArray(m) && Array.isArray(currentParsed)) {
            return JSON.stringify(m) === JSON.stringify(currentParsed);
          }
          return m == currentParsed;
        });
      if (!modeMatched) {
        const newMode = Array.isArray(data.mode[0]) ? JSON.stringify(data.mode[0]) : data.mode[0];
        modeChange(newMode);
      }
    });
  },
);
watch(
  () => [project.value?.videoModel, project.value?.mode],
  ([videoModel, projectMode]) => {
    const projectId = project.value?.id ?? null;
    const projectChanged = projectModelInitializedFor.value !== projectId;
    if (projectChanged) {
      projectModelInitializedFor.value = projectId;
      userSelectedModel.value = false;
    }
    if (videoModel && (projectChanged || (!userSelectedModel.value && !modelParmas.value.model))) modelParmas.value.model = String(videoModel);
    if (projectMode && !modelParmas.value.mode) modelParmas.value.mode = String(projectMode);
  },
  { immediate: true },
);
function parseMode(value: string): VideoMode | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as ReferenceType[];
  } catch {
    return value as Exclude<VideoMode, ReferenceType[]>;
  }
  return value as Exclude<VideoMode, ReferenceType[]>;
}
/** uploadBox 作为 promptEditor 的引用预览 */
const references = computed(() => {
  function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
    const ext = src?.split(".").pop()?.toLowerCase() ?? "";
    if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
    if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
    return "image";
  }

  return effectiveReferenceItems.value
    .filter((item) => item.src)
    .map((item) => ({
      type: getFileTypeByExt(item.src) as "image" | "video" | "audio" | "text",
      src: item.src ?? "",
    }));
});

async function getGenerateData() {
  const { data } = await axios.post("/production/workbench/getGenerateData", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
  });

  storyboardList.value = data.storyboardList;
  // 优先使用本地缓存，没有缓存则用后端数据并写入缓存
  const pid = project.value?.id;
  const sid = episodesId.value;
  if (pid != null && sid != null) {
    // 同步脚本级缓存，删除已不存在轨道的旧缓存，并为新增轨道建立缓存。
    syncCacheFromTrackList(pid, sid, data.trackList);
    if (isEffectiveSingleImageMode.value) {
      data.trackList.forEach((track: TrackItem) => {
        if (track.id == null) return;
        track.medias = normalizeSingleReferenceList(track.medias as unknown as UploadItem[]) as unknown as TrackMedia[];
        setCache(pid, sid, track.id, track.medias as unknown as UploadItem[]);
      });
    }
    // 批量向后端请求文件路径对应的完整 URL
    await warmUpUrls(pid, sid);
    // 将本地缓存回写到 trackList，确保优先使用缓存数据（src 已解析为完整 URL）
    data.trackList.forEach((track: TrackItem) => {
      if (track.id == null) return;
      const cached = getCache(pid, sid, track.id);
      if (cached?.length) {
        track.medias = (isEffectiveSingleImageMode.value ? normalizeSingleReferenceList(cached) : cached) as unknown as TrackMedia[];
      }
    });
    // 整体赋值触发响应式
    trackList.value = [...data.trackList];
  }

  modelParmas.value.duration = clampDuration(data.trackList?.[activeTrackIndex.value]?.duration);
}

function handleModelChange() {
  userSelectedModel.value = true;
}

function handleDurationChange(duration: number) {
  const nextDuration = clampDuration(duration);
  modelParmas.value.duration = nextDuration;
  if (currentTrack.value) {
    currentTrack.value.duration = nextDuration;
  }
}
/** 提示词失焦时保存到后端 */
function handlePromptBlur() {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  if (trackId == null) return;
  axios.post("/production/workbench/updateVideoPrompt", { id: trackId, prompt: currentTrack.value?.prompt });
}
const genTextLoadingMap = ref<Record<number, boolean>>({}); // trackId -> 是否正在生成提示词

function togglePromptAgent() {
  promptAgentVisible.value = !promptAgentVisible.value;
}

async function sendPromptAgentMessage() {
  const track = currentTrack.value;
  const trackId = track?.id;
  const message = promptAgentInput.value.trim();
  if (!trackId || !message || promptAgentLoading.value) return;

  const previousMessages = promptAgentMessagesMap.value[trackId] ?? [];
  const nextMessages = [...previousMessages, { role: "user" as const, content: message }];
  promptAgentMessagesMap.value = {
    ...promptAgentMessagesMap.value,
    [trackId]: nextMessages,
  };
  promptAgentInput.value = "";
  promptAgentLoading.value = true;
  try {
    const { data } = await axios.post(
      "/production/workbench/chatVideoPrompt",
      {
        projectId: project.value?.id,
        scriptId: episodesId.value ?? 0,
        trackId,
        message,
        currentPrompt: track.prompt || "",
        model: modelParmas.value.model,
        history: previousMessages.slice(-8),
      },
      { timeout: VIDEO_PROMPT_TIMEOUT },
    );
    track.prompt = data.prompt;
    promptAgentMessagesMap.value = {
      ...promptAgentMessagesMap.value,
      [trackId]: [...nextMessages, { role: "assistant", content: data.reply || "已修改当前视频提示词。" }],
    };
    window.$message.success("视频提示词已由 Agent 修改");
  } catch (e) {
    promptAgentMessagesMap.value = {
      ...promptAgentMessagesMap.value,
      [trackId]: [...nextMessages, { role: "assistant", content: (e as Error)?.message || "修改失败" }],
    };
    window.$message.error((e as Error)?.message ?? "提示词助手修改失败");
  } finally {
    promptAgentLoading.value = false;
  }
}

/** 单个轨道生成提示词 */
async function genText() {
  if (currentTrack.value.id == null || genTextLoadingMap.value[currentTrack.value.id]) return;
  let info = [];
  const currentTrackId = currentTrack.value.id;
  const changeTrack = currentTrack.value;
  if (modelParmas.value.mode == "text") {
    info = changeTrack?.medias.map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
  } else {
    info =
      modelParmas.value.mode === "text"
        ? []
        : (() => {
            const filtered = imageList.value.filter((item) => item.id);
            if (FRAME_MODES.includes(modelParmas.value.mode)) return filtered.slice(0, 2).map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
            if (isEffectiveSingleImageMode.value) {
              return normalizeSingleReferenceList(filtered).map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
            }
            return filtered.map(({ id, sources, referenceImageKind }) => ({ id, sources, referenceImageKind }));
          })();
  }
  genTextLoadingMap.value[currentTrackId] = true;
  try {
    const { data } = await axios.post(
      "/production/workbench/generateVideoPrompt",
      {
        projectId: project.value?.id,
        trackId: currentTrackId,
        info: info,
        model: modelParmas.value.model,
        duration: getCurrentGenerateDuration(),
      },
      { timeout: VIDEO_PROMPT_TIMEOUT },
    );
    changeTrack.prompt = data;
  } catch (e) {
    window.$message.error((e as Error)?.message ?? "提示词生成失败");
  } finally {
    genTextLoadingMap.value[currentTrackId] = false;
  }
}
function trackChange(prevIndex?: number) {
  // 切换前：将旧轨道的 imageList 保存到缓存
  if (prevIndex != null) {
    const prevTrack = trackList.value[prevIndex];
    const pid = project.value?.id;
    const sid = episodesId.value;
    if (pid != null && sid != null && prevTrack?.id != null) {
      setCache(pid, sid, prevTrack.id, prevTrack.medias as unknown as UploadItem[]);
    }
  }
  // 切换后：从缓存恢复当前轨道的 imageList
  const pid = project.value?.id;
  const sid = episodesId.value;
  const curTrack = trackList.value[activeTrackIndex.value];
  if (pid != null && sid != null && curTrack?.id != null) {
    const cached = getCache(pid, sid, curTrack.id);
    if (cached) {
      curTrack.medias = cached as unknown as TrackMedia[];
    }
  }
  modelParmas.value.duration = clampDuration(trackList.value?.[activeTrackIndex.value]?.duration);
}
/** 监听当前轨道的 medias 变化，实时同步到缓存 */
watch(
  () => currentTrack.value?.medias,
  (medias) => {
    if (!medias) return;
    const pid = project.value?.id;
    const sid = episodesId.value;
    const trackId = currentTrack.value?.id;
    if (pid != null && sid != null && trackId != null) {
      setCache(pid, sid, trackId, medias as unknown as UploadItem[]);
    }
  },
  { deep: true },
);

onMounted(() => {
  modelParmas.value.model = project.value?.videoModel || "";
  modelParmas.value.mode = project.value?.mode || "";
  getGenerateData();
  if (hasGenerateVideoIds.value && hasGenerateVideoIds.value.length) {
    startPoll();
  }
});
/** 单个轨道生成视频 */
async function generateVideo() {
  const trackId = trackList.value[activeTrackIndex.value]?.id;
  if (trackId == null || generatingMap.value[trackId]) return;
  const uploadData = getCurrentTrackUploadData();
  const duration = getCurrentGenerateDuration();
  const confirmed = await confirmGenerateVideo(activeTrackIndex.value, uploadData.length, duration);
  if (!confirmed) return;

  generatingMap.value[trackId] = true;
  try {
    const { data } = await axios.post("/production/workbench/generateVideo", {
      projectId: project.value?.id,
      scriptId: episodesId.value,
      uploadData,
      prompt: currentTrack.value.prompt,
      model: modelParmas.value.model,
      mode: modelParmas.value.mode,
      resolution: modelParmas.value.resolution,
      duration,
      audio: modelParmas.value.audio,
      trackId,
    });
    window.$message.success($t("workbench.generate.generateStarted"));
    const targetTrack = trackList.value.find((item) => item.id === trackId);
    const result = data as number | { id: number; prompt?: string };
    const videoId = typeof result === "object" ? result.id : result;
    if (typeof result === "object" && typeof result.prompt === "string" && targetTrack) {
      targetTrack.prompt = result.prompt;
    }
    targetTrack?.videoList.push({
      id: videoId,
      state: "生成中",
      src: "",
    });
  } catch (e) {
    window.$message.error((e as any)?.message ?? "视频发起生成请求失败");
  } finally {
    generatingMap.value[trackId] = false;
  }
}
let pollTimer: NodeJS.Timeout | null = null;

function startPoll() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => getVideoList(), 3000);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
const hasGenerateVideoIds = computed(() => {
  return trackList.value
    .map((track) => {
      return track.videoList.filter((i) => i.state == "生成中").map((i) => i.id);
    })
    .flatMap((i) => i);
});

/** 查询所有视频列表，并检测生成完成/失败状态 */
async function getVideoList() {
  const { data } = await axios.post("/production/workbench/getVideoList", {
    projectId: project.value?.id,
    scriptId: episodesId.value ?? 0,
    videoIds: hasGenerateVideoIds.value,
  });
  if (data && data.length) {
    let shouldRefreshGenerateData = false;
    data.forEach((item: { id: number; state: "生成中" | "未生成" | "已完成" | "生成失败"; src?: string; errorReason?: string }) => {
      for (const track of trackList.value) {
        const findData = track.videoList.find((i) => i.id == item.id);
        if (findData) {
          const wasCompleted = findData.state === "已完成";
          findData.state = item.state;
          findData.src = item?.src ?? "";
          findData.errorReason = item?.errorReason ?? "";
          if (!wasCompleted && item.state === "已完成") shouldRefreshGenerateData = true;
          break;
        }
      }
    });
    if (shouldRefreshGenerateData) {
      window.setTimeout(() => getGenerateData(), 1500);
    }
  }
}
watch(
  () => hasGenerateVideoIds.value,
  (newVal) => {
    if (newVal && newVal.length > 0) {
      startPoll();
    } else {
      stopPoll();
    }
  },
);

onUnmounted(() => {
  stopPoll();
});
</script>

<style lang="scss" scoped>
.index {
  height: calc(100vh - 120px);
  gap: 16px;
  overflow-y: auto;

  &.storyboardModeLayout {
    height: calc(100vh - 120px);
    min-height: 640px;
    overflow-y: auto;

    .modelSelect {
      flex: 0 0 auto;
    }

    .storyboardModeHost {
      display: block;
      flex: 0 0 auto;
      width: 100%;
      min-height: 620px;
    }

  }

  .referenceImage {
  }
  .modelSelect {
  }
  .generate {
    flex: 1;
    min-height: 0;
    width: 100%;
    gap: 5px;
    .prompt {
      width: 50%;
      height: 100%;
      min-height: 0;
      .videoPrompt {
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
        .promptData {
          width: 100%;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          .promptInput {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
          }
          .promptAgent {
            flex-shrink: 0;
            margin-top: 10px;
            padding: 10px;
            border: 1px solid var(--td-component-border);
            border-radius: 8px;
            background: var(--td-bg-color-container-hover);
          }
          .promptAgentHeader {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
            font-size: 13px;
            font-weight: 600;
            color: var(--td-text-color-primary);
          }
          .promptAgentHint {
            font-size: 12px;
            font-weight: 400;
            color: var(--td-text-color-secondary);
          }
          .promptAgentMessages {
            max-height: 170px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 8px;
          }
          .promptAgentEmpty {
            padding: 8px;
            border-radius: 6px;
            color: var(--td-text-color-secondary);
            background: var(--td-bg-color-container);
            font-size: 12px;
            line-height: 1.5;
          }
          .promptAgentMessage {
            display: flex;
            gap: 6px;
            align-items: flex-start;
            font-size: 12px;
            line-height: 1.5;
            &.user .messageRole {
              color: var(--td-brand-color);
            }
            &.assistant .messageRole {
              color: var(--td-success-color);
            }
          }
          .messageRole {
            flex: 0 0 auto;
            font-weight: 700;
          }
          .messageContent {
            min-width: 0;
            white-space: pre-wrap;
            word-break: break-word;
            color: var(--td-text-color-primary);
          }
          .promptAgentInputRow {
            display: flex;
            align-items: flex-end;
            gap: 8px;
          }
          .promptAgentInput {
            flex: 1;
          }
        }
      }
    }
    .video {
      width: 50%;
      height: 100%;
      min-height: 0;
    }
  }
  .track {
  }
}
</style>
