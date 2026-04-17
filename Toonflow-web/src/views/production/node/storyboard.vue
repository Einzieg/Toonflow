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
        <!-- <t-button block @click="batchGenerateImage" :disabled="!storyboard.length" :loading="generateLoading">
          {{ $t("workbench.production.node.storyboard.batchGenerateImage") }}
        </t-button> -->
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
import { LoadingPlugin } from "tdesign-vue-next";
import { Handle, Position, type Edge } from "@vue-flow/core";
import axios from "@/utils/axios";
import type { AssetItem, Storyboard } from "../utils/flowBuilder";
import { buildTencentCosPreviewUrl, getPreviewImageSrc } from "../utils/imagePreview";
import projectStore from "@/stores/project";
import productionAgentStore from "@/stores/productionAgent";
const { project } = storeToRefs(projectStore());
const { episodesId } = storeToRefs(productionAgentStore());
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
// async function batchGenerateImage() {
// LoadingPlugin(true);
// generateLoading.value = true;
// try {
//   await batchGenerateStoryboard();
//   window.$message.success($t("workbench.production.node.storyboard.batchGenerateSuccess"));
// } catch (e) {
//   window.$message.error($t("workbench.production.node.storyboard.batchGenerateFailed"));
// } finally {
//   generateLoading.value = false;
// }
// const allIds = (storyboard.value ?? []).filter((s) => s.src).map((s) => s.id!);
// if (!allIds.length) {
//   window.$message.warning($t("workbench.production.node.storyboard.noPreviewImages"));
//   LoadingPlugin(false);
//   return;
// }
// axios.post("/production/storyboard/batchGenerateImage", {
//   scriptId: allIds,
// });
// }
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
      for (const id of item.associateAssetsIds) {
        // 先查顶层 asset
        const asset = props.assetsData.find((a) => a.id === id);
        if (asset) {
          if (asset.src) assetsImages.push(asset.src);
          continue;
        }
        // 再查 derive
        for (const a of props.assetsData) {
          const derive = a.derive?.find((d) => d.id === id);
          if (derive) {
            if (derive.src) assetsImages.push(derive.src);
            break;
          }
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
  const previewUrl = buildTencentCosPreviewUrl(imageUrl, { width: 480, format: "webp" });

  // 插入模式：在两张图之间新增一条分镜
  if (id === null && insertAfterIndex !== null) {
    const newFrame: Storyboard = {
      duration: 0,
      prompt: "",
      src: imageUrl,
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
    target.src = imageUrl;
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

function editInfo(item: Storyboard) {
  const formData = reactive({
    prompt: item.prompt ?? "",
    videoDesc: item?.videoDesc ?? "",
  });

  const bodyVNode = () =>
    h("div", { class: "editInfoForm" }, [
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
    max-height: min(72vh, 980px);
    overflow: auto;
    overscroll-behavior: contain;
    content-visibility: auto;
    contain: layout style;
    contain-intrinsic-size: auto 720px;
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
</style>
