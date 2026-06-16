<template>
  <t-card class="storyboardFirstNode">
    <Handle :id="handleIds.target" type="target" :position="Position.Top" />
    <div class="titleBar dragHandle">
      <div>
        <div class="title">故事板先行 · 分镜脚本</div>
        <div class="subTitle">剧本 → 分镜脚本，不依赖分镜面板</div>
      </div>
      <t-button size="small" variant="outline" :loading="loading" @click="refresh">刷新</t-button>
    </div>

    <div class="controls">
      <t-input-number v-model="targetDuration" size="small" :min="6" :max="60" label="时长" />
      <t-button size="small" theme="primary" :loading="actionLoading" @click="generate(false)">生成脚本</t-button>
      <t-button size="small" variant="outline" :loading="actionLoading" @click="generate(true)">重新生成</t-button>
      <t-button size="small" theme="danger" variant="outline" :disabled="!script" @click="clearAll">清空</t-button>
    </div>

    <t-alert v-if="script?.errorReason" theme="error" :message="script.errorReason" />
    <t-alert v-else-if="script?.state === '生成中'" theme="info" message="分镜脚本正在生成中" />

    <div v-if="script" class="meta">
      状态：{{ script.state }} · 版本：{{ script.scriptRevision }} · 镜头数：{{ script.segmentCount || "-" }} · 目标：{{ script.targetDuration || targetDuration }}s
    </div>
    <pre v-if="script?.shotScript" class="scriptPreview">{{ script.shotScript }}</pre>
    <t-empty v-else description="暂无故事板先行分镜脚本" />

    <div class="footerActions">
      <t-button size="small" variant="outline" :disabled="!script?.shotScript" @click="openEdit">编辑脚本</t-button>
    </div>

    <Handle :id="handleIds.source" type="source" :position="Position.Right" />

    <t-dialog
      v-model:visible="editVisible"
      header="编辑故事板先行分镜脚本"
      width="760px"
      confirm-btn="保存"
      cancel-btn="取消"
      :close-on-overlay-click="false"
      @confirm="saveEdit">
      <t-textarea v-model="editContent" :autosize="{ minRows: 18, maxRows: 28 }" />
    </t-dialog>
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

const { script, loading, actionLoading, refresh, generateScript, updateScript, clearWorkflow } = useStoryboardFirstWorkflow(
  computed(() => props.projectId),
  computed(() => props.scriptId),
);
const targetDuration = ref(10);
const editVisible = ref(false);
const editContent = ref("");

async function generate(force: boolean) {
  try {
    await generateScript(targetDuration.value, force);
    window.$message.success(force ? "分镜脚本已开始重新生成" : "分镜脚本已开始生成");
  } catch (e) {
    window.$message.error((e as any)?.message || "分镜脚本生成失败");
  }
}

function openEdit() {
  editContent.value = script.value?.shotScript || "";
  editVisible.value = true;
}

async function saveEdit() {
  if (!script.value?.id) return;
  try {
    await updateScript(script.value.id, editContent.value);
    editVisible.value = false;
    window.$message.success("分镜脚本已更新");
  } catch (e) {
    window.$message.error((e as any)?.message || "保存失败");
  }
}

async function clearAll() {
  const dialog = DialogPlugin.confirm({
    header: "清空故事板先行工作流",
    body: "将清空当前剧集的故事板先行分镜脚本、故事板图片和故事板视频，不影响分镜面板和主视频工作台。",
    theme: "warning",
    confirmBtn: "清空",
    cancelBtn: "取消",
    onConfirm: async () => {
      try {
        await clearWorkflow();
        window.$message.success("已清空故事板先行工作流");
      } catch (e) {
        window.$message.error((e as any)?.message || "清空失败");
      } finally {
        dialog.destroy();
      }
    },
  });
}
</script>

<style scoped lang="scss">
.storyboardFirstNode {
  width: 520px;

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
    background: #12312f;
    font-size: 16px;
    font-weight: 700;
  }

  .subTitle,
  .meta {
    margin-top: 6px;
    color: var(--td-text-color-secondary);
    font-size: 12px;
  }

  .controls,
  .footerActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }

  .scriptPreview {
    max-height: 360px;
    overflow: auto;
    padding: 12px;
    border-radius: 8px;
    background: var(--td-bg-color-container-hover, #f5f5f5);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
    font-size: 13px;
  }
}
</style>
