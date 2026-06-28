import type { Ref } from "vue";
import { computed } from "vue";

// ==================== 固定节点 ID ====================
const NODE_IDS = {
  script: "script",
  scriptPlan: "scriptPlan",
  assets: "assets",
  storyboardTable: "storyboardTable",
  storyboard: "storyboard",
  workbench: "workbench",
  storyboardFirstScript: "storyboardFirstScript",
  storyboardFirstImage: "storyboardFirstImage",
  storyboardFirstVideo: "storyboardFirstVideo",
  poster: "poster",
} as const;

type NodeId = (typeof NODE_IDS)[keyof typeof NODE_IDS];

// ==================== 类型定义 ====================
export interface DeriveAsset {
  id: number;
  assetsId: number | null;
  name: string;
  prompt: string;
  desc: string;
  src: string;
  thumbSrc?: string | null;
  flowId?: number;
  voiceProfile?: string | null;
  voiceTone?: string | null;
  speechRate?: string | null;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  type: "role" | "tool" | "scene" | "clip";
  errorReason?: string;
}

export interface AssetItem {
  id: number;
  name: string;
  desc: string;
  prompt: string;
  src: string;
  thumbSrc?: string | null;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  type: "role" | "tool" | "scene" | "clip";
  voiceProfile?: string | null;
  voiceTone?: string | null;
  speechRate?: string | null;
  flowId?: number;
  derive: DeriveAsset[];
  errorReason?: string;
}

export interface Storyboard {
  id?: number;
  duration?: number;
  shotMeta?: {
    sourceShotNo?: number;
    dialogueCharCount?: number | null;
    estimatedSpeechRate?: string | null;
    estimatedSpeechDuration?: number | null;
    durationReason?: string | null;
    durationReasonSource?: string | null;
  } | null;
  prompt: string;
  trackId?: number;
  associateAssetsIds?: number[];
  src: string | null;
  thumbSrc?: string | null;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  flowId?: number;
  reason?: string;
  videoDesc: string;
  shouldGenerateImage: number;
}

interface VideoList {
  id: number;
  prompt: string;
  duration: number;
  storyboardId: number;
  trackId: number;
}

export interface FlowData {
  script: string;
  scriptPlan: string;
  shotPlan?: unknown | null;
  shotPolicy?: unknown | null;
  targetDuration?: number | null;
  targetDurationSource?: string | null;
  scriptTargetDuration?: number | null;
  scriptTargetDurationSource?: string | null;
  scriptTargetDurationRaw?: string | null;
  assets: AssetItem[];
  storyboardTable: string;
  storyboard: Storyboard[];
  workbench: {
    name: string;
    duration: string;
    resolution: string;
    fps: string;
    cover?: string;
    gradient?: string;
    videoList: VideoList[];
  };
}

export type NodePositions = Record<string, { x: number; y: number }>;

// 边样式
const edgeStyle = {
  stroke: "#00000",
  strokeWidth: 4,
};

// ==================== 构建函数 ====================
export function useFlowBuilder(nodePositions: Ref<NodePositions>) {
  const nodes = computed(() => {
    const positions = nodePositions.value;
    const ids = NODE_IDS;

    const allNodes = [
      // 1. Script 节点
      {
        id: ids.script,
        type: "script",
        dragHandle: ".dragHandle",
        position: positions[ids.script] || { x: 0, y: 0 },
        data: {
          handleIds: {
            assets: `${ids.script}-assets`,
            source: `${ids.script}-source`,
            storyboardFirst: `${ids.script}-storyboardFirst`,
          },
        },
      },
      // 1.5 ScriptPlan 节点
      {
        id: ids.scriptPlan,
        type: "scriptPlan",
        dragHandle: ".dragHandle",
        position: positions[ids.scriptPlan] || { x: 0, y: 0 },
        data: {
          handleIds: {
            target: `${ids.scriptPlan}-target`,
            source: `${ids.scriptPlan}-source`,
          },
        },
      },
      // 2. Assets 节点
      {
        id: ids.assets,
        type: "assets",
        dragHandle: ".dragHandle",
        position: positions[ids.assets] || { x: 0, y: 0 },
        data: {
          handleIds: {
            target: `${ids.assets}-target`,
          },
        },
      },
      // 3. StoryboardTable 节点
      {
        id: ids.storyboardTable,
        type: "storyboardTable",
        dragHandle: ".dragHandle",
        position: positions[ids.storyboardTable] || { x: 0, y: 0 },
        data: {
          handleIds: {
            target: `${ids.storyboardTable}-target`,
            source: `${ids.storyboardTable}-source`,
          },
        },
      },
      // 4. Storyboard 节点
      {
        id: ids.storyboard,
        type: "storyboard",
        dragHandle: ".dragHandle",
        position: positions[ids.storyboard] || { x: 0, y: 0 },
        data: {
          handleIds: {
            target: `${ids.storyboard}-target`,
            source: `${ids.storyboard}-source`,
          },
        },
      },
      // 5. Workbench 节点
      {
        id: ids.workbench,
        type: "workbench",
        dragHandle: ".dragHandle",
        position: positions[ids.workbench] || { x: 0, y: 0 },
        data: {
          handleIds: {
            target: `${ids.workbench}-target`,
            source: `${ids.workbench}-source`,
          },
        },
      },
      {
        id: ids.storyboardFirstScript,
        type: "storyboardFirstScript",
        dragHandle: ".dragHandle",
        position: positions[ids.storyboardFirstScript] || { x: 0, y: 900 },
        data: {
          handleIds: {
            target: `${ids.storyboardFirstScript}-target`,
            source: `${ids.storyboardFirstScript}-source`,
          },
        },
      },
      {
        id: ids.storyboardFirstImage,
        type: "storyboardFirstImage",
        dragHandle: ".dragHandle",
        position: positions[ids.storyboardFirstImage] || { x: 600, y: 900 },
        data: {
          handleIds: {
            target: `${ids.storyboardFirstImage}-target`,
            source: `${ids.storyboardFirstImage}-source`,
          },
        },
      },
      {
        id: ids.storyboardFirstVideo,
        type: "storyboardFirstVideo",
        dragHandle: ".dragHandle",
        position: positions[ids.storyboardFirstVideo] || { x: 1100, y: 900 },
        data: {
          handleIds: {
            target: `${ids.storyboardFirstVideo}-target`,
          },
        },
      },
      // 6. Poster 节点
      // {
      //   id: ids.poster,
      //   type: "poster",
      //   dragHandle: ".dragHandle",
      //   position: positions[ids.poster] || { x: 0, y: 0 },
      //   data: {
      //     items: data.poster?.items ?? [],
      //     handleIds: {
      //       target: `${ids.poster}-target`,
      //     },
      //   },
      // },
    ];

    return allNodes;
  });

  const edges = computed(() => {
    const ids = NODE_IDS;

    const allEdges = [
      // Script -> Assets
      {
        id: `${ids.script}-${ids.assets}`,
        source: ids.script,
        target: ids.assets,
        sourceHandle: `${ids.script}-assets`,
        targetHandle: `${ids.assets}-target`,
        animated: false,
        style: edgeStyle,
      },
      // Script -> StoryboardTable
      {
        id: `${ids.script}-${ids.scriptPlan}`,
        source: ids.script,
        target: ids.scriptPlan,
        sourceHandle: `${ids.script}-source`,
        targetHandle: `${ids.scriptPlan}-target`,
        animated: false,
        style: edgeStyle,
      },
      // ScriptPlan -> StoryboardTable
      {
        id: `${ids.scriptPlan}-${ids.storyboardTable}`,
        source: ids.scriptPlan,
        target: ids.storyboardTable,
        sourceHandle: `${ids.scriptPlan}-source`,
        targetHandle: `${ids.storyboardTable}-target`,
        animated: false,
        style: edgeStyle,
      },
      // StoryboardTable -> Storyboard
      {
        id: `${ids.storyboardTable}-${ids.storyboard}`,
        source: ids.storyboardTable,
        target: ids.storyboard,
        sourceHandle: `${ids.storyboardTable}-source`,
        targetHandle: `${ids.storyboard}-target`,
        animated: false,
        style: edgeStyle,
      },
      // Storyboard -> Workbench
      {
        id: `${ids.storyboard}-${ids.workbench}`,
        source: ids.storyboard,
        target: ids.workbench,
        sourceHandle: `${ids.storyboard}-source`,
        targetHandle: `${ids.workbench}-target`,
        animated: false,
        style: edgeStyle,
      },
      {
        id: `${ids.script}-${ids.storyboardFirstScript}`,
        source: ids.script,
        target: ids.storyboardFirstScript,
        sourceHandle: `${ids.script}-storyboardFirst`,
        targetHandle: `${ids.storyboardFirstScript}-target`,
        animated: false,
        style: edgeStyle,
      },
      {
        id: `${ids.storyboardFirstScript}-${ids.storyboardFirstImage}`,
        source: ids.storyboardFirstScript,
        target: ids.storyboardFirstImage,
        sourceHandle: `${ids.storyboardFirstScript}-source`,
        targetHandle: `${ids.storyboardFirstImage}-target`,
        animated: false,
        style: edgeStyle,
      },
      {
        id: `${ids.storyboardFirstImage}-${ids.storyboardFirstVideo}`,
        source: ids.storyboardFirstImage,
        target: ids.storyboardFirstVideo,
        sourceHandle: `${ids.storyboardFirstImage}-source`,
        targetHandle: `${ids.storyboardFirstVideo}-target`,
        animated: false,
        style: edgeStyle,
      },
      // Workbench -> Poster
      // {
      //   id: `${ids.workbench}-${ids.poster}`,
      //   source: ids.workbench,
      //   target: ids.poster,
      //   sourceHandle: `${ids.workbench}-source`,
      //   targetHandle: `${ids.poster}-target`,
      //   animated: false,
      //   style: edgeStyle,
      // },
    ];

    return allEdges;
  });

  return { nodes, edges };
}
