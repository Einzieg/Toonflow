<template>
  <t-card class="storyboard">
    <div class="titleBar dragHandle pr">
      <div class="title">{{ $t("workbench.production.node.storyboard.title") }}</div>
      <Handle :id="props.handleIds.target" type="target" :position="Position.Left" style="left: calc(-1 * var(--td-comp-paddingLR-xl))" />
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="content">
      <t-empty v-if="!storyboard.length" style="margin-top: 16px"></t-empty>
      <div v-else class="frameGridWrap">
        <div class="batchBar">
          <div class="batchLeft">
            <t-checkbox
              :checked="isAllSelectableSelected"
              :indeterminate="isPartiallySelected"
              :disabled="!selectableStoryboardIds.length || generateLoading"
              @change="toggleSelectAll">
              全选可生成分镜
            </t-checkbox>
            <span class="batchCount">已选 {{ selectedStoryboardIds.length }} / {{ selectableStoryboardIds.length }}</span>
          </div>
          <div class="batchActions">
            <t-button size="small" variant="outline" :disabled="!selectedStoryboardIds.length || generateLoading" @click="clearSelection">清空选择</t-button>
            <t-button size="small" theme="primary" :disabled="!selectedStoryboardIds.length || generateLoading" :loading="generateLoading" @click="regenerateSelectedImages">
              重新生成选中
            </t-button>
          </div>
        </div>
        <div class="frameGrid">
          <storyboardFrameItem
            v-for="(item, index) in storyboard"
            :key="item.id ?? `storyboard-${index}`"
            :item="item"
            :index="index"
            :grid-scale="gridScale"
            :style-max-size="styleMaxSize"
            :tag-color="tagColors[index % tagColors.length]"
            :display-src="getStoryboardDisplaySrc(item)"
            :selectable="isStoryboardSelectable(item)"
            :selected="isStoryboardSelected(item.id)"
            @toggle-selected="(selected) => toggleStoryboardSelection(item.id, selected)"
            @open="editStoryboaryImage(item, item.src ? [item.src] : [])"
            @remove="removeFn(item.id!)"
            @edit-info="editInfo(item)"
            @insert-left="editStoryboaryImage(item, [index > 0 ? storyboard[index - 1]?.src || '' : '', item.src || ''], index - 1)"
            @insert-right="editStoryboaryImage(item, [item.src || '', index < (storyboard?.length ?? 0) - 1 ? storyboard[index + 1]?.src || '' : ''], index)" />
        </div>
      </div>
      <div class="scaleControl">
        <span>{{ $t("workbench.production.node.storyboard.scaleRatio") }}</span>
        <t-input-number v-model="gridScale" :min="0.1" :max="3" :step="0.1" :decimal-places="1" size="small" style="width: 120px" />
      </div>
      <div class="ac" style="gap: 10px">
        <t-button block @click="previewAll" :disabled="!storyboard.length">{{ $t("workbench.production.node.storyboard.gridPreview") }}</t-button>
        <t-button block @click="batchGenerateImage" :disabled="!canBatchGenerateImage" :loading="generateLoading">
          {{ batchGenerateButtonText }}
        </t-button>
      </div>
    </div>
    <editImage v-model="visible" v-if="visible" :flowData="currentRow" type="storyboard" @save="save" />
    <t-image-viewer
      v-model:visible="previewVisible"
      :images="previewImages"
      :onClose="closePreview"
      :onDownload="downLoadImage"
      :imageScale="{ max: 10, min: 0.1 }" />
  </t-card>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { useLocalStorage } from "@vueuse/core";
import storyboardFrameItem from "./storyboardFrameItem.vue";
import { DialogPlugin, LoadingPlugin } from "tdesign-vue-next";
import { Handle, Position, type Edge } from "@vue-flow/core";
import axios from "@/utils/axios";
import type { AssetItem, Storyboard } from "../utils/flowBuilder";
import { appendCacheBust, getPreviewImageSrc, getVersionedPreviewImageSrc } from "../utils/imagePreview";
import projectStore from "@/stores/project";
import productionAgentStore from "@/stores/productionAgent";
const productionAgent = productionAgentStore();
const { project } = storeToRefs(projectStore());
const { episodesId } = storeToRefs(productionAgent);
const editImage = defineAsyncComponent(() => import("../components/editImage/index.vue"));

const props = defineProps<{
  id: string;
  handleIds: {
    target: string;
    source: string;
  };
  assetsData: AssetItem[];
}>();

const storyboard = defineModel<Storyboard[]>({ required: true });

const visible = ref(false);
const previewVisible = ref(false);
const previewImages = ref<string[]>([]);
const gridScale = useLocalStorage("storyboardGridScale", 1);
const generateLoading = ref(false);
const selectedStoryboardIds = ref<number[]>([]);

const currentRow = ref<{
  flowId?: number | null;
  resultImages: { src: string; prompt: string }[];
  referanceImages: string[];
}>({
  flowId: null,
  resultImages: [],
  referanceImages: [],
});

const tagColors = ["#5bccb3", "#9c7cfc", "#fbbf24", "#5b9afc", "#e86b6b", "#7cb8fc", "#e8a855", "#34d399"];

function getStoryboardDisplaySrc(item: Storyboard) {
  return getPreviewImageSrc(item.thumbSrc, item.src, { width: 480, format: "webp" });
}

function closePreview() {
  previewImages.value = [];
}
async function downLoadImage() {
  LoadingPlugin(true);
  const allIds = (storyboard.value ?? []).filter((s) => s.src).map((s) => s.id!);
  if (!allIds.length) {
    window.$message.warning($t("workbench.production.node.storyboard.noPreviewImages"));
    LoadingPlugin(false);
    return;
  }
  try {
    const res = await axios.post(
      "/production/storyboard/downPreviewImage",
      {
        storyboardIds: allIds,
      },
      { responseType: "blob" },
    );
    // 创建下载链接
    const url = URL.createObjectURL(res as unknown as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `storyboardImagePreview-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    window.$message.error($t("workbench.production.node.storyboard.imageLoadFailed"));
  } finally {
    LoadingPlugin(false);
  }
}
async function previewAll() {
  LoadingPlugin(true);
  const allIds = (storyboard.value ?? []).filter((s) => s.src).map((s) => s.id!);
  if (!allIds.length) {
    window.$message.warning($t("workbench.production.node.storyboard.noPreviewImages"));
    LoadingPlugin(false);
    return;
  }
  try {
    const { data } = await axios.post("/production/storyboard/previewImage", {
      storyboardIds: allIds,
      projectId: project.value?.id,
    });
    previewImages.value = [data];
    previewVisible.value = true;
  } catch {
    window.$message.error($t("workbench.production.node.storyboard.imageLoadFailed"));
  } finally {
    LoadingPlugin(false);
  }
}
const currentRowStoryboardInfo = ref<{ id: number | null; insertAfterIndex: number | null }>({
  id: null,
  insertAfterIndex: null,
});
const styleMaxSize = computed(() => {
  if (gridScale.value <= 1) return gridScale.value;
  return 1;
});
const allStoryboardIds = computed(() =>
  Array.from(
    new Set(
      (storyboard.value ?? [])
        .filter((item) => item.id && item.shouldGenerateImage !== 0 && item.state !== "生成中" && item.prompt?.trim())
        .map((item) => item.id as number),
    ),
  ),
);
const pendingStoryboardIds = computed(() =>
  allStoryboardIds.value.filter((id) => {
    const item = storyboard.value.find((storyboardItem) => storyboardItem.id === id);
    return !item?.src || item.state === "未生成" || item.state === "生成失败";
  }),
);
const storyboardIdsToGenerate = computed(() => pendingStoryboardIds.value);
const selectableStoryboardIds = computed(() => allStoryboardIds.value);
const selectedStoryboardIdSet = computed(() => new Set(selectedStoryboardIds.value));
const isAllSelectableSelected = computed(
  () => selectableStoryboardIds.value.length > 0 && selectableStoryboardIds.value.every((id) => selectedStoryboardIdSet.value.has(id)),
);
const isPartiallySelected = computed(() => selectedStoryboardIds.value.length > 0 && !isAllSelectableSelected.value);
const selectedRegeneratableIds = computed(() => selectedStoryboardIds.value.filter((id) => selectableStoryboardIds.value.includes(id)));
const canBatchGenerateImage = computed(() => !generateLoading.value && (selectedRegeneratableIds.value.length > 0 || storyboardIdsToGenerate.value.length > 0));
const batchGenerateButtonText = computed(() =>
  selectedRegeneratableIds.value.length > 0 ? `重新生成选中（${selectedRegeneratableIds.value.length}）` : "生成未生成/失败分镜",
);

function isStoryboardSelectable(item: Storyboard) {
  return Boolean(item.id && item.shouldGenerateImage !== 0 && item.state !== "生成中" && item.prompt?.trim());
}

function isStoryboardSelected(id?: number) {
  return id != null && selectedStoryboardIdSet.value.has(id);
}

function toggleStoryboardSelection(id: number | undefined, selected: boolean) {
  if (id == null) return;
  if (!selectableStoryboardIds.value.includes(id)) return;
  if (selected) {
    if (!selectedStoryboardIds.value.includes(id)) selectedStoryboardIds.value.push(id);
  } else {
    selectedStoryboardIds.value = selectedStoryboardIds.value.filter((itemId) => itemId !== id);
  }
}

function toggleSelectAll(selected: boolean) {
  selectedStoryboardIds.value = selected ? [...selectableStoryboardIds.value] : [];
}

function clearSelection() {
  selectedStoryboardIds.value = [];
}

async function batchGenerateImage() {
  if (selectedRegeneratableIds.value.length) {
    regenerateSelectedImages();
    return;
  }
  if (!storyboardIdsToGenerate.value.length) {
    window.$message.warning("没有未生成/失败的分镜；如需重生成指定图片，请先勾选分镜图。");
    return;
  }
  LoadingPlugin(true);
  generateLoading.value = true;
  try {
    await productionAgent.batchGenerateStoryboard(storyboardIdsToGenerate.value);
    window.$message.success($t("workbench.production.node.storyboard.batchGenerateSuccess"));
  } catch (e) {
    window.$message.error((e as Error)?.message ?? $t("workbench.production.node.storyboard.batchGenerateFailed"));
  } finally {
    generateLoading.value = false;
    LoadingPlugin(false);
  }
}

async function runStoryboardRegeneration(ids: number[]) {
  if (!ids.length) return;
  LoadingPlugin(true);
  generateLoading.value = true;
  try {
    const data = await productionAgent.batchGenerateStoryboard(ids);
    const returnedIds = new Set((Array.isArray(data) ? data : []).map((item: { id?: number }) => item.id).filter(Boolean));
    if (!returnedIds.size) {
      await productionAgent.getFlowData();
      window.$message.warning("已发送重新生成请求，但服务端未返回可生成分镜，请检查当前分集或分镜提示词");
      return;
    }

    const missingCount = ids.filter((id) => !returnedIds.has(id)).length;
    await productionAgent.getFlowData();
    clearSelection();
    if (missingCount > 0) {
      window.$message.warning(`已发起 ${returnedIds.size} 张分镜图重新生成，${missingCount} 张未被服务端接收`);
    } else {
      window.$message.success(`已发起 ${ids.length} 张分镜图重新生成`);
    }
  } catch (e) {
    await productionAgent.getFlowData();
    window.$message.error((e as Error)?.message ?? "选中分镜图重新生成失败");
  } finally {
    generateLoading.value = false;
    LoadingPlugin(false);
  }
}

function regenerateSelectedImages() {
  const ids = selectedStoryboardIds.value.filter((id) => selectableStoryboardIds.value.includes(id));
  if (!ids.length) return;

  const dialog = DialogPlugin.confirm({
    header: "重新生成选中分镜图",
    body: `将重新生成已勾选的 ${ids.length} 张分镜图。已有图片会被新结果覆盖，分镜文字、资产关联和视频轨道不会删除。`,
    confirmBtn: "重新生成",
    cancelBtn: $t("settings.memory.msg.cancel"),
    theme: "warning",
    onConfirm: async () => {
      try {
        await runStoryboardRegeneration(ids);
      } finally {
        dialog.destroy();
      }
    },
    onCancel: () => dialog.destroy(),
  });
}
function resolveStoryboardAssetImage(id: number) {
  const asset = props.assetsData.find((a) => a.id === id);
  if (asset) {
    if (asset.type === "role") {
      const derivative = asset.derive?.find((d) => d.src);
      if (derivative?.src) return derivative.src;
    }
    return asset.src || "";
  }

  for (const parentAsset of props.assetsData) {
    const derivative = parentAsset.derive?.find((d) => d.id === id);
    if (derivative?.src) return derivative.src;
  }
  return "";
}

function editStoryboaryImage(item: Storyboard, images: string[], insertAfterIndex: number | null = null) {
  currentRowStoryboardInfo.value = {
    id: insertAfterIndex == null ? item?.id! : null,
    insertAfterIndex,
  };
  currentRow.value = {
    flowId: item?.flowId ?? null,
    resultImages: [],
    referanceImages: [],
  };

  if (currentRowStoryboardInfo.value.id) {
    let imagesPush: string[] = [];

    if (item.associateAssetsIds && item.associateAssetsIds.length > 0) {
      const assetsImages: string[] = [];
      const seenImages = new Set<string>();
      for (const id of item.associateAssetsIds) {
        const image = resolveStoryboardAssetImage(id);
        if (image && !seenImages.has(image)) {
          seenImages.add(image);
          assetsImages.push(image);
        }
      }
      imagesPush = imagesPush.concat(assetsImages);
    }
    // if (item?.referenceIds && item.referenceIds.length > 0) {
    //   const referenImages = storyboard.value
    //     .filter((s) => item.referenceIds!.includes(s.id))
    //     .map((s) => s.src)
    //     .filter(Boolean) as string[];
    //   imagesPush = imagesPush.concat(referenImages);
    // }
    currentRow.value.referanceImages = imagesPush;
    currentRow.value.resultImages = [{ src: images.length ? images[0] : "", prompt: item.prompt ?? "" }];
  } else {
    currentRow.value.referanceImages = images.filter(Boolean);
  }
  visible.value = true;
}

async function save({ imageUrl, flowId }: { imageUrl: string; flowId: number }) {
  if (!imageUrl) return;

  const { id, insertAfterIndex } = currentRowStoryboardInfo.value;
  const version = Date.now();
  const previewUrl = getVersionedPreviewImageSrc(undefined, imageUrl, { width: 480, format: "webp" }, version);
  const versionedImageUrl = appendCacheBust(imageUrl, version);

  // 插入模式：在两张图之间新增一条分镜
  if (id === null && insertAfterIndex !== null) {
    const newFrame: Storyboard = {
      duration: 0,
      prompt: "",
      src: versionedImageUrl,
      thumbSrc: previewUrl,
      videoDesc: "",
      shouldGenerateImage: 1,
      state: "已完成",
    };
    const { data } = await axios.post("/production/storyboard/addStoryboard", {
      ...newFrame,
      projectId: project.value?.id,
      scriptId: episodesId.value,
      flowId,
    });

    storyboard.value.splice(insertAfterIndex + 1, 0, { ...newFrame, id: data.id!, flowId });
    productionAgentStore().setFlowData();
    return;
  }

  // 更新模式：更新对应分镜的 src
  const target = storyboard.value.find((s) => s.id === id);
  if (target) {
    target.src = versionedImageUrl;
    target.thumbSrc = previewUrl;
    target.state = "已完成";
    target.flowId = flowId;
  }
  await axios.post("/production/storyboard/updateStoryboardUrl", {
    id: id,
    url: imageUrl,
    flowId,
  });
}

watch(
  selectableStoryboardIds,
  (ids) => {
    const idSet = new Set(ids);
    selectedStoryboardIds.value = selectedStoryboardIds.value.filter((id) => idSet.has(id));
  },
  { immediate: true },
);

async function removeFn(id: number) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.assets.confirmDeleteHeader"),
    body: $t("workbench.production.node.storyboard.confirmDeleteBody"),
    confirmBtn: $t("workbench.assets.deleteBtn"),
    cancelBtn: $t("workbench.assets.cancelBtn"),
    theme: "warning",
    onConfirm: async () => {
      if (!id) {
        const index = storyboard.value.findIndex((s) => s.id === id);
        if (index !== -1) {
          storyboard.value.splice(index, 1);
        }
        dialog.destroy();
        return;
      }
      try {
        await axios.post("/production/storyboard/removeFrame", {
          id,
          projectId: project.value?.id,
        });
        const index = storyboard.value.findIndex((s) => s.id === id);
        if (index !== -1) {
          storyboard.value.splice(index, 1);
        }
      } catch (e) {
        window.$message.error((e as any)?.message || $t("workbench.production.node.storyboard.removeFailed"));
      } finally {
        dialog.destroy();
      }
    },
  });
}

function formatShotTimingMeta(item: Storyboard) {
  const meta = item.shotMeta;
  if (!meta) return "";
  return [
    item.duration != null ? `分镜时长：${item.duration}s` : "",
    meta.dialogueCharCount != null ? `台词字数：${meta.dialogueCharCount}` : "",
    meta.estimatedSpeechRate ? `估算语速：${meta.estimatedSpeechRate}` : "",
    meta.estimatedSpeechDuration != null ? `口播时长：${meta.estimatedSpeechDuration}s` : "",
    meta.durationReason ? `依据：${meta.durationReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function editInfo(item: Storyboard) {
  const formData = reactive({
    prompt: item.prompt ?? "",
    videoDesc: item?.videoDesc ?? "",
  });
  const timingText = formatShotTimingMeta(item);

  const bodyVNode = () =>
    h("div", { class: "editInfoForm" }, [
      ...(timingText
        ? [
            h("div", { class: "editInfoField" }, [
              h("label", { class: "editInfoLabel" }, "Agent 时长依据"),
              h("pre", { class: "timingMetaText" }, timingText),
            ]),
          ]
        : []),
      h("div", { class: "editInfoField" }, [
        h("label", { class: "editInfoLabel" }, $t("workbench.production.node.storyboard.prompt")),
        h(resolveComponent("t-textarea"), {
          value: formData.prompt,
          placeholder: $t("workbench.production.node.storyboard.promptPlaceholder"),
          autosize: { minRows: 3, maxRows: 6 },
          "onUpdate:value": (v: string) => (formData.prompt = v),
        }),
      ]),
      h("div", { class: "editInfoField" }, [
        h("label", { class: "editInfoLabel" }, $t("workbench.production.node.storyboard.videoDesc")),
        h(resolveComponent("t-textarea"), {
          value: formData.videoDesc,
          placeholder: $t("workbench.production.node.storyboard.videoDescPlaceholder"),
          autosize: { minRows: 3, maxRows: 6 },
          "onUpdate:value": (v: string) => (formData.videoDesc = v),
        }),
      ]),
    ]);

  const confirmDialog = DialogPlugin.confirm({
    header: $t("workbench.production.node.storyboard.editInfo"),
    body: bodyVNode,
    width: 480,
    confirmBtn: {
      content: $t("common.submit"),
      theme: "primary",
      loading: false,
    },
    onConfirm: async () => {
      confirmDialog.update({ confirmBtn: { content: $t("common.submitting"), loading: true } });
      try {
        await axios.post("/production/storyboard/editStoryboardInfo", {
          id: item.id,
          prompt: formData.prompt,
          videoDesc: formData.videoDesc,
        });
        item.prompt = formData.prompt;
        item.videoDesc = formData.videoDesc;
        window.$message.success($t("common.editSuccess"));
      } catch (e) {
        window.$message.error((e as any)?.message || $t("common.editFailed"));
      } finally {
        confirmDialog.update({ confirmBtn: { content: $t("common.submit"), loading: false } });
        confirmDialog.destroy();
      }
    },
  });
}
</script>

<style lang="scss" scoped>
.storyboard {
  min-width: 500px;
  max-width: 100vw;
  user-select: text;
  cursor: default;
  contain: layout style;

  .titleBar {
    cursor: grab;
    user-select: none;
  }
  .title {
    background-color: #000;
    width: fit-content;
    padding: 5px 10px;
    color: #fff;
    border-radius: 8px 0;
    font-size: 16px;
  }

  .content {
    margin-top: 12px;
  }

  .frameGridWrap {
    max-width: min(84vw, 1280px);
    overflow: visible;
    content-visibility: auto;
    contain: layout style;
    contain-intrinsic-size: auto 720px;
  }

  .batchBar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
    padding: 8px 10px;
    border: 1px solid var(--td-component-border);
    border-radius: 8px;
    background: var(--td-bg-color-container);
  }

  .batchLeft,
  .batchActions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .batchLeft {
    flex-wrap: wrap;
  }

  .batchCount {
    font-size: 12px;
    color: var(--td-text-color-secondary);
    white-space: nowrap;
  }

  .frameGrid {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0;
    padding: 2px;
    min-width: fit-content;
    contain: layout style;
  }

  .scaleControl {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 13px;
    color: var(--td-text-color-primary, #333);
  }

  .frameInfo {
    margin-top: 6px;
    font-size: 12px;
    color: var(--td-text-color-primary, #333);
    line-height: 1.4;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
.editInfoForm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}

.editInfoField {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.editInfoLabel {
  font-size: 13px;
  color: var(--td-text-color-secondary);
}

.timingMetaText {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--td-component-border);
  border-radius: 6px;
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 12px;
  color: var(--td-text-color-primary);
  background: var(--td-bg-color-container-hover);
}
</style>
