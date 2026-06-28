<template>
  <t-card class="scriptPlan">
    <div class="titleBar dragHandle pr">
      <div class="title c">{{ $t("workbench.production.node.scriptPlan.title") }}</div>
      <t-button class="nodrag editBtn" size="small" variant="text" @pointerdown.stop @mousedown.stop @click.stop="openEdit">
        {{ $t("workbench.production.edit") }}
      </t-button>
      <Handle :id="props.handleIds.target" type="target" :position="Position.Left" style="left: calc(-1 * var(--td-comp-paddingLR-xl))" />
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="content">
      <t-empty v-if="!scriptPlan" style="margin-top: 16px"></t-empty>
      <div v-else class="contentPreview">
        <div class="planSummary">
          <span class="summaryPill">{{ scriptPlanOverview.charCount }} 字</span>
          <span v-if="scriptPlanOverview.sceneRows.length" class="summaryPill">{{ scriptPlanOverview.sceneRows.length }} 场</span>
          <span v-if="scriptPlanOverview.sections.length" class="summaryText">已解析 {{ scriptPlanOverview.sections.length }} 个章节</span>
        </div>
        <div v-if="scriptPlanOverview.sceneRows.length" class="sceneTableViewport">
          <table class="sceneTable">
            <thead>
              <tr>
                <th class="colSceneNo">场次</th>
                <th class="colSceneName">场景</th>
                <th class="colDialogueCount">台词</th>
                <th class="colCharCount">字数</th>
                <th class="colEmotion">情绪基调</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scriptPlanOverview.sceneRows" :key="row.key">
                <td class="colSceneNo">{{ row.no }}</td>
                <td class="colSceneName" :title="row.name">{{ row.name || "-" }}</td>
                <td class="colDialogueCount">{{ row.dialogueCount || "-" }}</td>
                <td class="colCharCount">{{ row.charCount || "-" }}</td>
                <td class="colEmotion" :title="row.emotion">{{ row.emotion || "-" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="scriptPlanOverview.sections.length" class="sectionList">
          <div v-for="section in scriptPlanOverview.sections" :key="section.key" class="sectionCard">
            <div class="sectionTitle">{{ section.title }}</div>
            <div class="sectionBody">{{ section.preview }}</div>
          </div>
        </div>
        <pre v-if="!scriptPlanOverview.sceneRows.length && !scriptPlanOverview.sections.length" class="previewText">{{ scriptPlanPreview }}</pre>
      </div>
    </div>
  </t-card>

  <t-dialog
    v-if="dialogVisible"
    v-model:visible="dialogVisible"
    :header="$t('workbench.production.node.scriptPlan.editDialog')"
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

const scriptPlan = defineModel<string>({ required: true });
const editContent = ref("");
const dialogVisible = ref(false);
const scriptPlanPreview = computed(() => buildTextPreview(scriptPlan.value, { maxLength: 1600, maxLines: 24 }));
const scriptPlanOverview = computed(() => parseScriptPlanOverview(scriptPlan.value));

type SceneSummaryRow = {
  key: string;
  no: string;
  name: string;
  dialogueCount: string;
  charCount: string;
  emotion: string;
};

type PlanSection = {
  key: string;
  title: string;
  preview: string;
};

const SCENE_PREVIEW_LIMIT = 10;
const SECTION_PREVIEW_LIMIT = 5;

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

function truncateText(value: string, limit: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}...` : normalized;
}

function parseSceneSummaryRows(value: string): SceneSummaryRow[] {
  const rows: SceneSummaryRow[] = [];
  let inSceneTable = false;
  let headerSeen = false;

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#{0,6}\s*分场汇总表/.test(line) || line === "分场汇总表") {
      inSceneTable = true;
      headerSeen = false;
      continue;
    }
    if (inSceneTable && /^#{1,6}\s+/.test(line) && !/分场汇总表/.test(line)) break;

    const cells = splitMarkdownTableRow(line);
    if (!inSceneTable || !cells.length || isSeparatorRow(cells)) continue;

    if (!headerSeen) {
      headerSeen = /场次|场景名|台词条数|情绪/.test(cells.join(""));
      continue;
    }

    if (!/^Sc?\d+|^\d+/.test(cells[0] || "")) continue;
    rows.push({
      key: `${cells[0] || rows.length}-${rows.length}`,
      no: truncateText(cells[0] || "", 8),
      name: truncateText(cells[1] || "", 40),
      dialogueCount: truncateText(cells[2] || "", 8),
      charCount: truncateText(cells[3] || "", 8),
      emotion: truncateText(cells[5] || cells[4] || "", 56),
    });
    if (rows.length >= SCENE_PREVIEW_LIMIT) break;
  }

  return rows;
}

function parsePlanSections(value: string): PlanSection[] {
  const sections: PlanSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentTitle) return;
    const preview = truncateText(
      currentLines
        .filter((line) => line && !line.startsWith("|") && !/^:?-{2,}:?$/.test(line))
        .join(" "),
      180,
    );
    if (preview) {
      sections.push({
        key: `${currentTitle}-${sections.length}`,
        title: currentTitle,
        preview,
      });
    }
  };

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^(?:#{1,6}\s*)?([①②③④⑤⑥⑦⑧⑨⑩]\s*.+|分场汇总表|逐场注意事项|场间过渡|关键镜头预设|主题立意.+|视觉风格.+|构图.+|声音.+)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].replace(/^#+\s*/, "").trim();
      currentLines = [];
      continue;
    }
    if (currentTitle && line) currentLines.push(line.replace(/^[-*]\s*/, ""));
  }
  flush();

  return sections.filter((section) => section.title !== "分场汇总表").slice(0, SECTION_PREVIEW_LIMIT);
}

function parseScriptPlanOverview(value: string | null | undefined) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim();
  return {
    charCount: normalized.length,
    sceneRows: parseSceneSummaryRows(normalized),
    sections: parsePlanSections(normalized),
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
  editContent.value = scriptPlan.value ?? "";
  dialogVisible.value = true;
}

function onConfirm() {
  scriptPlan.value = editContent.value;
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
.scriptPlan {
  width: min(86vw, 900px);
  min-width: 620px;
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
      width: 100%;
      max-height: 500px;
      overflow: hidden;
      padding: 12px;
      border-radius: 8px;
      background: var(--td-bg-color-container-hover, #f5f5f5);
      content-visibility: auto;
      contain: layout style;
      contain-intrinsic-size: auto 320px;
    }

    .editBtn {
      cursor: pointer;
    }

    .planSummary {
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

    .sceneTableViewport {
      max-height: 240px;
      overflow: auto;
      border: 1px solid var(--td-border-level-1-color, #e7e7e7);
      border-radius: 8px;
      background: var(--td-bg-color-container, #fff);
    }

    .sceneTable {
      width: 100%;
      min-width: 760px;
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

    .colSceneNo {
      width: 56px;
      color: var(--td-text-color-secondary, #666);
      font-weight: 700;
    }

    .colSceneName {
      width: 280px;
    }

    .colDialogueCount,
    .colCharCount {
      width: 58px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .colEmotion {
      width: 260px;
    }

    .sectionList {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      max-height: 220px;
      margin-top: 10px;
      overflow: auto;
    }

    .sectionCard {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--td-border-level-1-color, #e7e7e7);
      border-radius: 8px;
      background: var(--td-bg-color-container, #fff);
    }

    .sectionTitle {
      margin-bottom: 6px;
      overflow: hidden;
      color: var(--td-text-color-primary, #222);
      font-size: 13px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sectionBody {
      display: -webkit-box;
      overflow: hidden;
      color: var(--td-text-color-secondary, #666);
      font-size: 12px;
      line-height: 1.5;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
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
