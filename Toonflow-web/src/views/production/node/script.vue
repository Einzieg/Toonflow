<template>
  <t-card class="script">
    <div class="titleBar dragHandle pr">
      <div class="title c">{{ $t("workbench.production.node.script.title") }}</div>
      <t-button size="small" variant="text" @click="openEdit">{{ $t("workbench.production.edit") }}</t-button>
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="content">
      <t-empty v-if="!script" style="margin-top: 16px"></t-empty>
      <div v-else class="contentPreview">
        <pre class="previewText">{{ scriptPreview }}</pre>
      </div>
    </div>
    <Handle :id="props.handleIds.assets" type="source" :position="Position.Bottom" />
  </t-card>

  <t-dialog
    v-if="dialogVisible"
    v-model:visible="dialogVisible"
    :header="$t('workbench.production.node.script.editDialog')"
    :width="'90vw'"
    :confirm-btn="$t('workbench.production.save')"
    :cancel-btn="$t('workbench.production.cancel')"
    @confirm="onConfirm"
    @cancel="onCancel"
    @close="onCancel"
    :close-on-overlay-click="false"
    :destroy-on-close="true"
    :lazy="true"
    placement="center"
    attach="body">
    <MdEditor
      v-model="editContent"
      :theme="themeSetting.mode"
      :toolbars="toolbars"
      :footers="[]"
      style="height: 72vh"
      @onUploadImg="() => {}"
      @drop.prevent
      @paste="onPaste" />
  </t-dialog>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import { Handle, Position } from "@vue-flow/core";
import "md-editor-v3/lib/style.css";
import type { ToolbarNames } from "md-editor-v3";
import settingStore from "@/stores/setting";
import { buildTextPreview } from "../utils/textPreview";
const { themeSetting } = storeToRefs(settingStore());
const MdEditor = defineAsyncComponent(async () => (await import("md-editor-v3")).MdEditor);

const props = defineProps<{
  id: string;
  handleIds: {
    assets: string;
    source: string;
  };
}>();

const script = defineModel<string>({ required: true });
const editContent = ref("");
const dialogVisible = ref(false);
const scriptPreview = computed(() => buildTextPreview(script.value, { maxLength: 1600, maxLines: 24 }));

const toolbars: ToolbarNames[] = [
  "bold",
  "underline",
  "italic",
  "strikeThrough",
  "-",
  "title",
  "sub",
  "sup",
  "quote",
  "unorderedList",
  "orderedList",
  "task",
  "-",
  "codeRow",
  "code",
  "table",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];

function openEdit() {
  editContent.value = script.value ?? "";
  dialogVisible.value = true;
}

function onConfirm() {
  script.value = editContent.value;
  dialogVisible.value = false;
}

function onCancel() {
  dialogVisible.value = false;
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
      e.preventDefault();
      return;
    }
  }
}
</script>

<style lang="scss" scoped>
.script {
  max-width: 100vw;
  width: fit-content;
  min-width: 200px;
  user-select: text;
  cursor: default;
  contain: layout style;

  .titleBar {
    cursor: grab;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    margin-top: 8px;

    .contentPreview {
      max-width: min(72vw, 720px);
      max-height: 420px;
      overflow: auto;
      padding: 12px;
      border-radius: 8px;
      background: var(--td-bg-color-container-hover, #f5f5f5);
      content-visibility: auto;
      contain: layout style;
      contain-intrinsic-size: auto 320px;
    }

    .previewText {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      line-height: 1.6;
      color: var(--td-text-color-primary, #333);
      font-family: inherit;
    }
  }
}
</style>
