<template>
  <div class="imageUploadBox ac">
    <!-- 单图模式 -->
    <template v-if="mode == 'singleImage' || Array.isArray(parseMode(mode as string))">
      <div class="uploadBtn c fc" v-for="(item, index) in imageList" :key="index" @click="handleSingleImageReplace">
        <template v-if="item.src">
          <t-image :src="getItemPreviewSrc(item)" fit="contain" class="uploadPreview">
            <template #overlayContent></template>
          </t-image>
        </template>
        <template v-else-if="item.volcengineAssetUri">
          <t-tooltip theme="primary" :content="item.volcengineAssetUri">
            <span class="virtualAssetMark">火</span>
          </t-tooltip>
        </template>
        <template v-else>
          <t-tooltip theme="primary" :content="item?.prompt || ''">
            <span style="font-size: 20px">文</span>
          </t-tooltip>
        </template>
        <div class="imageToolsWrap" v-if="item.sources == 'storyboard' && item.index != null">
          {{ `${getReferenceBadgePrefix(item)}${item.index + 1}` }}
        </div>
        <button
          v-if="isPreviewableImage(item)"
          type="button"
          class="previewBtn c"
          :title="$t('components.imageTools.preview')"
          @mousedown.stop
          @click.stop.prevent="handlePreviewImage(item)">
          <i-expand-text-input size="14" />
        </button>
        <button
          v-if="isSingleImageMode"
          type="button"
          class="replaceBtn c"
          @mousedown.stop
          @click.stop.prevent="openStoryboardDialog">
          更换
        </button>
        <div class="clearBtn" @click.stop="splitImage(index)">
          <i-close size="12" />
        </div>
        <div class="source">
          <t-tag size="small">
            {{ item.sources == "storyboard" ? getReferenceSourceLabel(item) : $t("workbench.generate.assets") }}
          </t-tag>
        </div>
      </div>
    </template>
    <template v-else-if="mode == 'endFrameOptional' || mode == 'startFrameOptional' || mode == 'startEndRequired'">
      <div class="uploadBtn c fc" v-for="(item, index) in buildLabel" :key="item.value" @click="handleMixedAdd(item.value as 'start' | 'end')">
        <div v-if="!isEmptySlot(imageList?.[index])" style="flex: 1" class="ac">
          <template v-if="imageList?.[index]?.src">
            <img class="uploadPreview" :src="getItemPreviewSrc(imageList[index])" loading="lazy" decoding="async" />
          </template>
          <template v-else-if="imageList?.[index]?.volcengineAssetUri">
            <t-tooltip theme="primary" :content="imageList?.[index]?.volcengineAssetUri || ''">
              <span class="virtualAssetMark">火</span>
            </t-tooltip>
          </template>
          <template v-else>
            <t-tooltip theme="primary" :content="imageList?.[index]?.prompt || ''">
              <span style="font-size: 20px">文</span>
            </t-tooltip>
          </template>
          <div class="imageToolsWrap" v-if="imageList?.[index]?.sources == 'storyboard' && imageList?.[index]?.index != null">
            {{ `${getReferenceBadgePrefix(imageList[index])}${imageList[index]?.index + 1}` }}
          </div>
          <button
            v-if="isPreviewableImage(imageList?.[index])"
            type="button"
            class="previewBtn c"
            :title="$t('components.imageTools.preview')"
            @mousedown.stop
            @click.stop.prevent="handlePreviewImage(imageList[index])">
            <i-expand-text-input size="14" />
          </button>
          <div class="clearBtn" @click.stop="clearImage(index)">
            <i-close size="12" />
          </div>
          <div class="source">
            <t-tag size="small">
              {{
                imageList?.[index]?.sources == "storyboard"
                  ? getReferenceSourceLabel(imageList[index])
                  : $t("workbench.generate.assets")
              }}
            </t-tag>
          </div>
        </div>
        <template v-else>
          <i-plus size="24"></i-plus>
          {{ item.label }}
        </template>
      </div>
    </template>
    <div class="uploadBtn c fc" v-if="isShowAddImage" @click="handleAddReference">
      <i-plus size="24"></i-plus>
      {{ $t("workbench.generate.addReference") }}
    </div>

    <!-- 分镜选择弹窗 -->
    <t-dialog
      v-model:visible="storyboardDialogVisible"
      :header="$t('workbench.generate.selectStoryboard')"
      :footer="false"
      width="800px"
      placement="center">
      <div class="storyboardGrid">
        <div class="storyboardItem" v-for="sb in storyboardList" :key="sb.id">
          <div class="storyboardTitle">P{{ (sb.index ?? 0) + 1 }}</div>
          <div class="variantGrid">
            <button type="button" class="variantCard" @click="pickStoryboard(sb, 'storyboard')">
              <img v-if="sb.src" :src="getStoryboardPreviewSrc(sb)" loading="lazy" decoding="async" />
              <div v-else class="textBox ac jc">
                <t-tooltip theme="primary" :content="sb?.videoDesc || ''">
                  <span>分镜图未生成</span>
                </t-tooltip>
              </div>
              <span class="variantLabel">分镜图</span>
            </button>
            <button type="button" class="variantCard" :class="{ disabled: !sb.gridSrc }" @click="pickStoryboard(sb, 'grid')">
              <img v-if="sb.gridSrc" :src="getStoryboardGridPreviewSrc(sb)" loading="lazy" decoding="async" />
              <div v-else class="textBox ac jc">
                <t-loading v-if="sb.gridImageState === '生成中' || gridGeneratingMap[sb.id]" size="18px" />
                <span v-else>未生成宫格</span>
              </div>
              <span class="variantLabel">宫格图</span>
            </button>
            <button type="button" class="variantCard" :class="{ disabled: !sb.tailFrameSrc }" @click="pickStoryboard(sb, 'tailFrame')">
              <img v-if="sb.tailFrameSrc" :src="getStoryboardTailFramePreviewSrc(sb)" loading="lazy" decoding="async" />
              <div v-else class="textBox ac jc">
                <span>未缓存尾帧</span>
              </div>
              <span class="variantLabel">视频尾帧</span>
            </button>
          </div>
          <div class="gridActions">
            <t-button
              size="small"
              variant="outline"
              :loading="sb.gridImageState === '生成中' || gridGeneratingMap[sb.id]"
              @click.stop="generateGridImage(sb)">
              {{ sb.gridSrc ? "重新生成宫格" : "生成宫格" }}
            </t-button>
            <t-tooltip v-if="sb.gridImageState === '生成失败'" theme="light" :content="sb.gridImageReason || '生成失败'">
              <t-tag size="small" theme="danger">失败</t-tag>
            </t-tooltip>
          </div>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import "@/views/production/components/workbench/type/type";
import assetsCheck, { type AssetType, type ClipMediaType } from "@/utils/assetsCheck";
import { getPreviewImageSrc } from "@/views/production/utils/imagePreview";
import { openImagePreview } from "@/utils/imagePreviewOverlay";
import axios from "@/utils/axios";

const props = defineProps<{
  mode: VideoMode;
  storyboardList: StoryboardItem[];
}>();
const imageList = defineModel<UploadItem[]>({
  default: () => [],
});
const emit = defineEmits<{
  refresh: [];
}>();
//分镜选择弹窗
const storyboardDialogVisible = ref(false);
const gridGeneratingMap = ref<Record<number, boolean>>({});
type StoryboardReferenceImageKind = "storyboard" | "grid" | "tailFrame";

/** 空占位项，用于首尾帧模式中未设置的槽位 */
const EMPTY_SLOT: UploadItem = { fileType: "image", id: null, src: "" } as any;
function isEmptySlot(item: UploadItem | undefined): boolean {
  return !item || !item.id;
}

const buildLabel = computed(() => {
  const startOptional = props.mode === "startFrameOptional";
  const endOptional = props.mode === "endFrameOptional";
  return [
    { label: startOptional ? "首帧(可选)" : "首帧", value: "start" },
    { label: endOptional ? "尾帧(可选)" : "尾帧", value: "end" },
  ];
});

const isSingleImageMode = computed(() => props.mode === "singleImage");

/** 确保 imageList 始终有两个槽位（首帧 index=0，尾帧 index=1） */
function ensureFrameSlots(): UploadItem[] {
  const list = [...imageList.value];
  while (list.length < 2) list.push({ ...EMPTY_SLOT });
  return list;
}

/** 将 item 设置到首帧或尾帧槽位 */
function setFrameSlot(slot: "start" | "end", item: UploadItem) {
  const list = ensureFrameSlots();
  list[slot === "start" ? 0 : 1] = item;
  imageList.value = list;
}

/** 解析模式值（字符串或 JSON 数组） */
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

//判断是否显示添加参考图
const isShowAddImage = computed(() => {
  const mode = props.mode;
  if (mode == "singleImage" && imageList.value.length >= 1) {
    return false;
  }
  if (mode == "endFrameOptional" || mode == "startEndRequired" || mode == "startFrameOptional") {
    return false;
  }
  if (mode == "text") return false;
  //多参模式默认 true
  return true;
});

/** 根据文件扩展名推断媒体类型 */
function getFileTypeByExt(src: string | undefined): "image" | "video" | "audio" {
  const ext = src?.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "image";
}

function getItemPreviewSrc(item?: UploadItem) {
  return getPreviewImageSrc(undefined, item?.src, { width: 160, height: 160, format: "webp" });
}

function getStoryboardPreviewSrc(item: StoryboardItem) {
  return getPreviewImageSrc((item as any).thumbSrc, item.src, { width: 320, format: "webp" });
}
function getStoryboardGridPreviewSrc(item: StoryboardItem) {
  return getPreviewImageSrc(undefined, item.gridSrc, { width: 320, format: "webp" });
}
function getStoryboardTailFramePreviewSrc(item: StoryboardItem) {
  return getPreviewImageSrc(undefined, item.tailFrameSrc, { width: 320, format: "webp" });
}
function getReferenceBadgePrefix(item?: Pick<UploadItem, "referenceImageKind"> | TrackMedia) {
  if (item?.referenceImageKind === "grid") return "宫格";
  if (item?.referenceImageKind === "tailFrame") return "尾帧";
  return "P";
}
function getReferenceSourceLabel(item?: Pick<UploadItem, "referenceImageKind"> | TrackMedia) {
  if (item?.referenceImageKind === "grid") return "宫格图";
  if (item?.referenceImageKind === "tailFrame") return "视频尾帧";
  return "分镜图";
}
function getStoryboardReferenceSrc(sb: StoryboardItem, referenceImageKind: StoryboardReferenceImageKind) {
  if (referenceImageKind === "grid") return sb.gridSrc;
  if (referenceImageKind === "tailFrame") return sb.tailFrameSrc;
  return sb.src;
}
function getMissingReferenceMessage(referenceImageKind: StoryboardReferenceImageKind) {
  if (referenceImageKind === "grid") return "该分镜还没有宫格图，请先生成";
  if (referenceImageKind === "tailFrame") return "该分镜还没有可用视频尾帧，请先生成并选择该分镜视频";
  return "该分镜还没有分镜图";
}
function isPreviewableImage(item?: UploadItem) {
  return !!item?.src && item.fileType !== "video" && item.fileType !== "audio";
}
function handlePreviewImage(item?: UploadItem) {
  const src = item?.src;
  if (!src || item.fileType === "video" || item.fileType === "audio") return;
  openImagePreview(src);
}
/** 根据混合模式推导当前允许的 clip 媒体类型 */
const mixedClipMediaTypes = computed<ClipMediaType[]>(() => {
  const mode = props.mode;
  if (!Array.isArray(mode)) return [];
  const map: Record<string, ClipMediaType> = { audioReference: "audio", imageReference: "image", videoReference: "video" };
  return mode.filter((m) => m in map).map((m) => map[m]);
});
let currentSlot: "start" | "end" | "" = "";
function handleMixedAdd(slot: "start" | "end" | "" = "") {
  currentSlot = slot;
  const multiple = Array.isArray(parseMode(props.mode as string));
  const dlg = DialogPlugin.confirm({
    header: $t("workbench.generate.selectSource"),
    confirmBtn: $t("workbench.generate.confirm"),
    cancelBtn: $t("workbench.generate.cancel"),
    onConfirm: async () => {
      dlg.destroy();
      const assets = await assetsCheck({ types: ["role", "tool", "scene", "clip"], clipMediaTypes: mixedClipMediaTypes.value, multiple });

      if (!assets.length) return;

      const newItems: UploadItem[] = assets.map((asset) => {
        const fileType = getFileTypeByExt(asset.src);
        return {
          fileType,
          sources: "assets",
          src: asset.src,
          id: asset.id,
          prompt: asset.prompt,
          volcengineAssetUri: asset.volcengineAssetUri,
          voiceProfile: asset.voiceProfile,
          voiceTone: asset.voiceTone,
          speechRate: asset.speechRate,
        };
      });
      if (slot === "start" || slot === "end") {
        setFrameSlot(slot, newItems[0]);
      } else {
        imageList.value = [...imageList.value, ...newItems];
      }
    },
    onCancel: () => {
      dlg.destroy();
      storyboardDialogVisible.value = true;
    },
  });
}
function handleAddReference() {
  if (isSingleImageMode.value) {
    openStoryboardDialog();
    return;
  }
  handleMixedAdd();
}
function openStoryboardDialog() {
  currentSlot = "";
  storyboardDialogVisible.value = true;
}
function handleSingleImageReplace() {
  if (!isSingleImageMode.value) return;
  openStoryboardDialog();
}
function clearImage(index: number) {
  const list = ensureFrameSlots();
  list[index] = { ...EMPTY_SLOT };
  imageList.value = list;
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function generateGridImage(sb: StoryboardItem) {
  if (!sb.id || gridGeneratingMap.value[sb.id]) return;
  gridGeneratingMap.value[sb.id] = true;
  try {
    await axios.post("/production/storyboard/generateGridImage", {
      storyboardId: sb.id,
      projectId: sb.projectId,
      scriptId: sb.scriptId,
      force: true,
    });
    window.$message.success("已开始生成四宫格图");
    emit("refresh");
    for (let i = 0; i < 40; i += 1) {
      await sleep(3000);
      emit("refresh");
      const current = props.storyboardList.find((item) => item.id === sb.id);
      if (current?.gridImageState && current.gridImageState !== "生成中") break;
    }
  } catch (e) {
    window.$message.error((e as Error)?.message ?? "四宫格图生成失败");
  } finally {
    gridGeneratingMap.value[sb.id] = false;
  }
}
/** 分镜弹窗选中回调 */
function pickStoryboard(sb: StoryboardItem, referenceImageKind: StoryboardReferenceImageKind = "storyboard") {
  const src = getStoryboardReferenceSrc(sb, referenceImageKind);
  if (!src) {
    window.$message.warning(getMissingReferenceMessage(referenceImageKind));
    return;
  }
  storyboardDialogVisible.value = false;
  const fileType = "image";
  const newItem = {
    fileType,
    sources: "storyboard",
    src,
    id: sb.id,
    prompt: sb.videoDesc ?? undefined,
    index: sb.index,
    referenceImageKind,
    gridSrc: sb.gridSrc,
    gridImageState: sb.gridImageState,
    gridImageReason: sb.gridImageReason,
    tailFrameSrc: sb.tailFrameSrc,
    tailFrameVideoId: sb.tailFrameVideoId,
  } as UploadItem;

  if (currentSlot === "start" || currentSlot === "end") {
    setFrameSlot(currentSlot, newItem);
  } else if (isSingleImageMode.value) {
    imageList.value = [newItem];
  } else {
    imageList.value = [...imageList.value, newItem];
  }
}
function splitImage(index: number) {
  const list = [...imageList.value];
  list.splice(index, 1);
  imageList.value = list;
}
</script>

<style lang="scss" scoped>
.imageUploadBox {
  gap: 8px;
  overflow-x: auto;
  flex-wrap: nowrap;
  padding-bottom: 6px;
  &::-webkit-scrollbar {
    height: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: #696969;
    border-radius: 4px;
  }
  &::-webkit-scrollbar-track {
    background-color: var(--td-bg-color-secondarycontainer);
    border-radius: 4px;
  }
  .uploadBtn {
    width: 80px;
    min-width: 80px;
    height: 80px;
    flex-shrink: 0;
    position: relative;
    border: 1px dashed var(--td-component-border);
    border-radius: 8px;
    &:hover {
      border-color: var(--td-text-color);
      cursor: pointer;
    }
    .imageToolsWrap {
      position: absolute;
      left: 4px;
      top: 4px;
      padding: 0 5px;
      font-size: 11px;
      line-height: 18px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border-radius: 4px;
      backdrop-filter: blur(4px);
      user-select: none;
      white-space: nowrap;
    }
    .uploadPreview {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 8px;
    }
    .virtualAssetMark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 999px;
      background: var(--td-brand-color-light);
      color: var(--td-brand-color);
      font-size: 18px;
      font-weight: 700;
    }
    .previewBtn {
      position: absolute;
      left: 4px;
      bottom: 4px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.62);
      color: #fff;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      &:hover {
        background: rgba(0, 0, 0, 0.85);
      }
    }
    &:hover .previewBtn {
      display: flex;
    }
    .replaceBtn {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      min-width: 42px;
      height: 24px;
      padding: 0 8px;
      border: none;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.68);
      color: #fff;
      font-size: 12px;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      &:hover {
        background: rgba(0, 0, 0, 0.88);
      }
    }
    &:hover .replaceBtn {
      display: flex;
    }
    .clearBtn {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      &:hover {
        background: rgba(0, 0, 0, 0.85);
      }
    }
    &:hover .clearBtn {
      display: flex;
    }
    .source {
      position: absolute;
      bottom: 2px;
      right: 2px;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      &:hover {
        background: rgba(0, 0, 0, 0.85);
      }
    }
    &:hover .source {
      display: flex;
    }
  }
  .storyboardGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 4px;
    .storyboardItem {
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--td-component-border);
      background: var(--td-bg-color-container);
      padding: 8px;
      .storyboardTitle {
        font-size: 12px;
        color: var(--td-text-color-secondary);
        margin-bottom: 6px;
      }
      .variantGrid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .variantCard {
        position: relative;
        display: block;
        width: 100%;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 6px;
        overflow: hidden;
        background: var(--td-bg-color-secondarycontainer);
        cursor: pointer;
        &:hover {
          border-color: var(--td-brand-color);
        }
        &.disabled {
          opacity: 0.72;
        }
      }
      img {
        width: 100%;
        aspect-ratio: 16/9;
        object-fit: cover;
        display: block;
      }
      .textBox {
        aspect-ratio: 16/9;
        width: 100%;
        text-align: center;
        color: var(--td-text-color-placeholder);
        font-size: 12px;
      }
      .variantLabel {
        position: absolute;
        left: 4px;
        bottom: 4px;
        padding: 0 6px;
        border-radius: 4px;
        color: #fff;
        background: rgba(0, 0, 0, 0.58);
        font-size: 11px;
        line-height: 18px;
      }
      .gridActions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
    }
  }
}
</style>
