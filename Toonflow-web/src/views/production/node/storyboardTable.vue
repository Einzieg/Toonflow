<template>
  <t-card class="storyboardTable">
    <div class="titleBar dragHandle pr">
      <div class="title c">{{ $t("workbench.production.node.storyboardTable.title") }}</div>
      <t-button class="nodrag editBtn" size="small" variant="text" @pointerdown.stop @mousedown.stop @click.stop="openEdit">
        {{ $t("workbench.production.edit") }}
      </t-button>
      <Handle :id="props.handleIds.target" type="target" :position="Position.Left" style="left: calc(-1 * var(--td-comp-paddingLR-xl))" />
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="storyboardList">
      <t-empty v-if="!storyboardTable" style="margin-top: 16px"></t-empty>
      <div v-else class="contentPreview">
        <div class="tableSummary">
          <span class="summaryPill">共 {{ storyboardTableRows.total }} 条</span>
          <span v-if="storyboardTableRows.totalDuration > 0" class="summaryPill">{{ storyboardTableRows.totalDuration }}s</span>
          <span v-if="storyboardTableRows.total" class="summaryText">已展示全部解析行</span>
        </div>
        <div v-if="storyboardTableRows.preview.length" class="tableViewport">
          <table class="shotTable">
            <thead>
              <tr>
                <th class="colNo">#</th>
                <th class="colScene">场景</th>
                <th class="colDuration">秒</th>
                <th class="colShot">景别</th>
                <th class="colVisual">画面 / 动作</th>
                <th class="colDialogue">台词</th>
                <th class="colAssets">资产</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in storyboardTableRows.preview" :key="row.key">
                <td class="colNo">{{ row.no }}</td>
                <td class="colScene" :title="row.scene">{{ row.scene || "-" }}</td>
                <td class="colDuration">{{ row.duration || "-" }}</td>
                <td class="colShot" :title="row.shot">{{ row.shot || "-" }}</td>
                <td class="colVisual" :title="row.visual">{{ row.visual || "-" }}</td>
                <td class="colDialogue" :title="row.dialogue">{{ row.dialogue || "无台词" }}</td>
                <td class="colAssets" :title="row.assets">{{ row.assets || "-" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <pre v-else class="previewText previewText--mono">{{ storyboardTablePreview }}</pre>
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
      :theme="themeSetting.mode === 'auto' ? 'light' : themeSetting.mode"
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
const storyboardTableRows = computed(() => parseStoryboardTablePreview(storyboardTable.value));

type StoryboardTablePreviewRow = {
  key: string;
  no: string;
  scene: string;
  duration: string;
  shot: string;
  visual: string;
  dialogue: string;
  assets: string;
};

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, "").replace(/[（）()]/g, "").trim();
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/<br\s*\/?>/gi, " / "));
}

function isSeparatorRow(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function findColumn(headers: string[] | null, aliases: string[], fallback: number) {
  if (!headers?.length) return fallback;
  const normalizedAliases = aliases.map(normalizeHeader);
  const index = headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
  return index >= 0 ? index : fallback;
}

function getCell(cells: string[], index: number) {
  if (index < 0) return "";
  return (cells[index] ?? "").trim();
}

function truncateCell(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}...` : normalized;
}

function parseDuration(value: string) {
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseStoryboardTablePreview(value: string | null | undefined): {
  preview: StoryboardTablePreviewRow[];
  total: number;
  totalDuration: number;
} {
  const rows: StoryboardTablePreviewRow[] = [];
  let total = 0;
  let totalDuration = 0;
  let headers: string[] | null = null;

  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const cells = splitMarkdownTableRow(rawLine);
    if (!cells.length || isSeparatorRow(cells)) continue;

    const firstCell = cells[0] ?? "";
    const looksLikeHeader = /序号|编号|画面|场景|时长|台词/.test(cells.join(""));
    if (!Number.isFinite(Number(firstCell)) && looksLikeHeader) {
      headers = cells;
      continue;
    }

    if (!Number.isFinite(Number(firstCell))) continue;

    const noIndex = findColumn(headers, ["序号", "编号"], 0);
    const visualIndex = findColumn(headers, ["画面描述", "画面", "画面内容"], 1);
    const sceneIndex = findColumn(headers, ["场景", "场景名"], 2);
    const assetNamesIndex = findColumn(headers, ["资产", "引用资产名称", "关联资产名称", "参演角色"], 3);
    const durationIndex = findColumn(headers, ["时长", "持续时长"], 4);
    const shotIndex = findColumn(headers, ["景别"], 5);
    const actionIndex = findColumn(headers, ["动作", "角色动作", "动作目标"], 7);
    const dialogueIndex = findColumn(headers, ["台词", "对白"], 10);
    const assetIdsIndex = findColumn(headers, ["关联资产ID", "引用资产ID", "资产ID"], 12);

    const duration = parseDuration(getCell(cells, durationIndex));
    total += 1;
    totalDuration += duration;

    const visual = [getCell(cells, visualIndex), getCell(cells, actionIndex)].filter(Boolean).join("；");
    const assets = getCell(cells, assetIdsIndex) || getCell(cells, assetNamesIndex);
    rows.push({
      key: `${getCell(cells, noIndex) || total}-${total}`,
      no: getCell(cells, noIndex) || String(total),
      scene: truncateCell(getCell(cells, sceneIndex), 24),
      duration: duration ? String(duration) : "",
      shot: truncateCell(getCell(cells, shotIndex), 16),
      visual: truncateCell(visual, 96),
      dialogue: truncateCell(getCell(cells, dialogueIndex), 80),
      assets: truncateCell(assets, 36),
    });
  }

  return {
    preview: rows,
    total,
    totalDuration: Number(totalDuration.toFixed(1)),
  };
}

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
  width: min(92vw, 1120px);
  min-width: 760px;
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
      width: 100%;
      overflow: visible;
      padding: 12px;
      border-radius: 8px;
      background: var(--td-bg-color-container-hover, #f5f5f5);
      content-visibility: auto;
      contain: layout style;
      contain-intrinsic-size: auto 360px;
    }

    .editBtn {
      cursor: pointer;
    }

    .tableSummary {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      color: var(--td-text-color-secondary, #666);
      font-size: 12px;
      user-select: none;
    }

    .summaryPill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      color: var(--td-text-color-primary, #222);
      background: var(--td-bg-color-container, #fff);
      border: 1px solid var(--td-border-level-1-color, #e7e7e7);
      font-weight: 600;
    }

    .summaryText {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tableViewport {
      overflow-x: auto;
      overflow-y: visible;
      border: 1px solid var(--td-border-level-1-color, #e7e7e7);
      border-radius: 8px;
      background: var(--td-bg-color-container, #fff);
    }

    .shotTable {
      width: 100%;
      min-width: 980px;
      border-collapse: separate;
      border-spacing: 0;
      table-layout: fixed;
      font-size: 12px;
      line-height: 1.45;
      color: var(--td-text-color-primary, #333);

      th,
      td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);
        vertical-align: top;
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--td-bg-color-container, #fff);
        color: var(--td-text-color-secondary, #666);
        font-weight: 700;
        text-align: left;
        user-select: none;
      }

      tr:last-child td {
        border-bottom: none;
      }

      td {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .colNo {
      width: 44px;
      color: var(--td-text-color-secondary, #666);
      font-weight: 700;
    }

    .colScene {
      width: 110px;
    }

    .colDuration {
      width: 54px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .colShot {
      width: 88px;
    }

    .colVisual {
      width: 320px;
    }

    .colDialogue {
      width: 250px;
    }

    .colAssets {
      width: 114px;
      color: var(--td-text-color-secondary, #666);
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
