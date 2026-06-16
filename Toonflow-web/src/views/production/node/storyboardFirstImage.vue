<template>
  <t-card class="storyboardFirstNode">
    <Handle :id="handleIds.target" type="target" :position="Position.Left" />
    <div class="titleBar dragHandle">
      <div>
        <div class="title">故事板先行 · 故事板图片</div>
        <div class="subTitle">固定 9:16 竖版，预览加载原图</div>
      </div>
      <t-button size="small" variant="outline" :loading="loading" @click="refresh">刷新</t-button>
    </div>

    <t-alert v-if="image?.stale" theme="warning" message="脚本已更新，故事板图片需重新生成" />
    <t-alert v-if="image?.errorReason" theme="error" :message="image.errorReason" />

    <div class="imageBox" @click="previewImage">
      <img v-if="image?.thumbUrl || image?.imageUrl" :src="image.thumbUrl || image.imageUrl" loading="lazy" />
      <t-empty v-else description="暂无故事板图片" />
    </div>

    <div class="meta">
      状态：{{ image?.state || "未生成" }} · 版本：{{ image?.version || "-" }} · 9:16 竖版
    </div>

    <div class="controls">
      <t-button size="small" theme="primary" :disabled="!script?.id" :loading="actionLoading" @click="generate(false)">生成图片</t-button>
      <t-button size="small" variant="outline" :disabled="!image?.id" :loading="actionLoading" @click="regenerate">重新生成</t-button>
      <t-button size="small" variant="outline" :disabled="!image?.imageUrl" @click="previewImage">预览原图</t-button>
      <t-button size="small" variant="outline" :disabled="!image?.imageUrl" @click="openUrl(image?.imageUrl || '')">下载图片</t-button>
      <t-button size="small" theme="danger" variant="outline" :disabled="!image?.id" @click="deleteImage">删除图片</t-button>
    </div>

    <Handle :id="handleIds.source" type="source" :position="Position.Right" />
    <t-image-viewer v-model:visible="previewVisible" :images="previewImages" :imageScale="{ max: 10, min: 0.1 }" />
  </t-card>
</template>

<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import { DialogPlugin } from "tdesign-vue-next";
import { useStoryboardFirstWorkflow } from "../composables/useStoryboardFirstWorkflow";

const props = defineProps<{
  id: string;
  projectId?: number | null;
  scriptId?: number | null;
  handleIds: {
    target: string;
    source: string;
  };
}>();

const { script, image, loading, actionLoading, refresh, generateImage, regenerateImage, deleteWorkflow } = useStoryboardFirstWorkflow(
  computed(() => props.projectId),
  computed(() => props.scriptId),
);
const previewVisible = ref(false);
const previewImages = ref<string[]>([]);

async function generate(force: boolean) {
  if (!script.value?.id) return;
  try {
    await generateImage(script.value.id, force);
    window.$message.success(force ? "故事板图片已开始重新生成" : "故事板图片已开始生成");
  } catch (e) {
    window.$message.error((e as any)?.message || "故事板图片生成失败");
  }
}

async function regenerate() {
  if (!image.value?.id) return;
  try {
    await regenerateImage(image.value.id);
    window.$message.success("故事板图片已开始重新生成");
  } catch (e) {
    window.$message.error((e as any)?.message || "重生成失败");
  }
}

function previewImage() {
  if (!image.value?.imageUrl) return;
  previewImages.value = [image.value.imageUrl];
  previewVisible.value = true;
}

function openUrl(url: string) {
  if (url) window.open(url, "_blank");
}

function deleteImage() {
  if (!image.value?.id) return;
  const dialog = DialogPlugin.confirm({
    header: "删除故事板图片",
    body: "将删除当前故事板图片及其故事板视频，不影响分镜脚本。",
    theme: "warning",
    confirmBtn: "删除",
    cancelBtn: "取消",
    onConfirm: async () => {
      try {
        await deleteWorkflow({ firstImageId: image.value?.id });
        window.$message.success("已删除故事板图片");
      } catch (e) {
        window.$message.error((e as any)?.message || "删除失败");
      } finally {
        dialog.destroy();
      }
    },
  });
}
</script>

<style scoped lang="scss">
.storyboardFirstNode {
  width: 420px;

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
    background: #35441c;
    font-size: 16px;
    font-weight: 700;
  }

  .subTitle,
  .meta {
    margin-top: 6px;
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .imageBox {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 180px;
    height: 300px;
    margin: 12px 0;
    overflow: hidden;
    border: 1px solid var(--td-border-level-1-color);
    border-radius: 12px;
    background: #f4f1ea;
    cursor: zoom-in;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
}
</style>
