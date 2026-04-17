<template>
  <t-card class="storyboardTable">
    <div class="titleBar dragHandle pr">
      <div class="title c">{{ $t("workbench.production.node.storyboardTable.title") }}</div>
      <t-button size="small" variant="text" @click="openEdit">{{ $t("workbench.production.edit") }}</t-button>
      <Handle :id="props.handleIds.target" type="target" :position="Position.Left" style="left: calc(-1 * var(--td-comp-paddingLR-xl))" />
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="storyboardList">
      <t-empty v-if="!storyboardTable" style="margin-top: 16px"></t-empty>
      <div v-else class="contentPreview">
        <pre class="previewText previewText--mono">{{ storyboardTablePreview }}</pre>
      </div>
    </div>
  </t-card>

  <t-dialog
    v-if="dialogVisible"
    v-model:visible="dialogVisible"
    :header="$t('workbench.production.node.storyboardTable.editDialog')"
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
    target: string;
    source: string;
  };
}>();

const storyboardTable = defineModel<string>({ required: true });
const editContent = ref("");
const dialogVisible = ref(false);
const storyboardTablePreview = computed(() => buildTextPreview(storyboardTable.value, { maxLength: 2200, maxLines: 28 }));

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
  editContent.value = storyboardTable.value ?? "";
  dialogVisible.value = true;
}

function onConfirm() {
  storyboardTable.value = editContent.value;
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
.storyboardTable {
  max-width: 100vw;
  width: fit-content;
  min-width: 100px;
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

  .storyboardList {
    display: flex;
    flex-direction: column;
    margin-top: 8px;

    .contentPreview {
      max-width: min(72vw, 960px);
      max-height: 480px;
      overflow: auto;
      padding: 12px;
      border-radius: 8px;
      background: var(--td-bg-color-container-hover, #f5f5f5);
      content-visibility: auto;
      contain: layout style;
      contain-intrinsic-size: auto 360px;
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

    .previewText--mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
  }

  .storyboardItem {
    display: flex;
    align-items: flex-start;
    padding: 12px 0;
    border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);

    &:last-child {
      border-bottom: none;
    }
  }

  .itemTag {
    flex-shrink: 0;
    width: 36px;
    height: 22px;
    border-radius: 4px;
    color: #fff;
    font-size: 12px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 12px;
    margin-top: 2px;
  }

  .itemContent {
    flex: 1;
    min-width: 0;
  }

  .itemHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .itemTags {
    display: flex;
    gap: 5px;
    flex-shrink: 0;
    margin-left: 12px;
  }

  .itemTitle {
    font-size: 14px;
    color: var(--td-text-color-primary, #333);
    line-height: 1.5;
  }

  .itemDetail {
    font-size: 12px;
    color: var(--td-text-color-secondary, #999);
    line-height: 1.4;

    .sep {
      margin: 0 6px;
      color: var(--td-border-level-1-color, #ddd);
    }
  }
}
</style>
