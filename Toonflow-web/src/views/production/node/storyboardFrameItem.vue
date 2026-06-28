<template>
  <div ref="frameRef" class="storyboardFrameItem" :class="{ selected, selectable }" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <button type="button" class="addBetween addBetween--left" :aria-label="`${frameLabel}-left`" @click.stop="$emit('insert-left')">
      <i-plus />
    </button>

    <div class="frameCard">
      <div
        class="frameImage"
        :style="{
          width: `${200 * gridScale}px`,
          height: `${200 * gridScale}px`,
        }">
        <div class="frameTypeTag" :style="{ backgroundColor: tagColor, transform: `scale(${styleMaxSize})` }">
          {{ frameLabel }}
        </div>
        <t-checkbox
          v-if="selectable"
          class="selectCheck"
          :checked="selected"
          :style="{ transform: `scale(${styleMaxSize})` }"
          @click.stop
          @change="(value: boolean) => $emit('toggle-selected', value)" />
        <div v-if="timingBadge" class="timingBadge" :style="{ transform: `scale(${styleMaxSize})` }">
          {{ timingBadge }}
        </div>

        <template v-if="showImage">
          <img
            v-if="shouldMountMedia"
            :key="displaySrc"
            :src="displaySrc"
            :alt="frameLabel"
            class="frameImg"
            loading="lazy"
            decoding="async"
            fetchpriority="low"
            @click="$emit('open')" />
          <div v-else class="deferredPlaceholder" @click="$emit('open')">
            <span>{{ frameLabel }}</span>
          </div>
        </template>

        <div v-else-if="isImageSkipped" class="skippedPlaceholder" @click="$emit('open')">
          <span>不生成图片</span>
        </div>

        <div v-else class="generatingPlaceholder" @click="$emit('open')">
          <t-loading v-if="item.state === '生成中'" size="small" />
          <t-tooltip v-else-if="item.state === '生成失败'" :content="item?.reason">
            <span style="color: #ff4d4f; cursor: pointer">生成失败</span>
          </t-tooltip>
          <t-empty v-else size="small" :title="$t('workbench.production.node.storyboard.notGenerated')" />
        </div>

        <div v-if="hovered && showImage" class="imageToolsWrap show">
          <ImageTools :style="{ transform: `scale(${styleMaxSize})` }" :src="item.src || displaySrc" position="br" />
        </div>

        <button
          type="button"
          class="actionBtn remove"
          :style="{ transform: `scale(${styleMaxSize})` }"
          :title="$t('workbench.production.node.storyboard.deleteNode')"
          @click.stop="$emit('remove')">
          <i-delete theme="outline" size="18" fill="#fff" />
        </button>

        <button
          type="button"
          class="actionBtn editNode"
          :style="{ transform: `scale(${styleMaxSize})` }"
          :title="$t('workbench.production.node.storyboard.editNode')"
          @click.stop="$emit('edit-info')">
          <i-edit theme="outline" size="18" fill="#fff" />
        </button>
      </div>
    </div>

    <button type="button" class="addBetween addBetween--right" :aria-label="`${frameLabel}-right`" @click.stop="$emit('insert-right')">
      <i-plus />
    </button>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { useIntersectionObserver } from "@vueuse/core";
import type { Storyboard } from "../utils/flowBuilder";

const ImageTools = defineAsyncComponent(() => import("@/components/imageTools.vue"));

const props = defineProps<{
  item: Storyboard;
  index: number;
  gridScale: number;
  styleMaxSize: number;
  tagColor: string;
  displaySrc: string;
  selectable?: boolean;
  selected?: boolean;
}>();

defineEmits<{
  (e: "insert-left"): void;
  (e: "insert-right"): void;
  (e: "open"): void;
  (e: "remove"): void;
  (e: "edit-info"): void;
  (e: "toggle-selected", selected: boolean): void;
}>();

const hovered = ref(false);
const frameRef = ref<HTMLElement | null>(null);
const hasIntersected = ref(false);

const isImageSkipped = computed(() => Number(props.item.shouldGenerateImage) === 0);
const showImage = computed(() => !isImageSkipped.value && Boolean(props.item.src && props.item.state === "已完成"));
const frameLabel = computed(() => `S${String(props.index + 1).padStart(2, "0")}`);
const shouldMountMedia = computed(() => !showImage.value || hasIntersected.value || hovered.value);
const timingBadge = computed(() => {
  const meta = props.item.shotMeta;
  if (!meta) return "";
  const parts = [
    props.item.duration != null ? `${props.item.duration}s` : "",
    meta.dialogueCharCount != null ? `${meta.dialogueCharCount}字` : "",
    meta.estimatedSpeechRate || "",
  ].filter(Boolean);
  return parts.join(" · ");
});

useIntersectionObserver(
  frameRef,
  ([entry]) => {
    if (entry?.isIntersecting) {
      hasIntersected.value = true;
    }
  },
  {
    rootMargin: "160px 160px 160px 160px",
  },
);
</script>

<style lang="scss" scoped>
.storyboardFrameItem {
  position: relative;
  display: inline-flex;
  align-items: flex-start;
  margin: 4px;
  content-visibility: auto;
  contain: layout paint style;
  contain-intrinsic-size: auto 220px;

  &:hover,
  &:focus-within {
    .addBetween,
    .actionBtn {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.frameCard {
  display: flex;
  flex-direction: column;
  cursor: pointer;
  contain: layout style;
}

.frameImage {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--td-bg-color-container-hover, #f5f5f5);
  contain: layout style;
}

.storyboardFrameItem.selected .frameImage {
  outline: 3px solid var(--td-brand-color, #0052d9);
  outline-offset: 2px;
}

.frameImg,
.deferredPlaceholder,
.skippedPlaceholder,
.generatingPlaceholder {
  width: 100%;
  height: 100%;
}

.frameImg {
  display: block;
  object-fit: cover;
}

.deferredPlaceholder,
.skippedPlaceholder,
.generatingPlaceholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.deferredPlaceholder {
  background:
    linear-gradient(135deg, rgba(0, 0, 0, 0.03), rgba(0, 0, 0, 0.08)),
    var(--td-bg-color-container-hover, #f5f5f5);
  color: var(--td-text-color-secondary, #999);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.generatingPlaceholder {
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.skippedPlaceholder {
  color: var(--td-text-color-placeholder, #999);
  font-size: 12px;
  background:
    repeating-linear-gradient(135deg, rgba(0, 0, 0, 0.04) 0 8px, transparent 8px 16px),
    var(--td-bg-color-container-hover, #f5f5f5);
}

.frameTypeTag {
  position: absolute;
  left: 6px;
  top: 6px;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  z-index: 2;
  padding: 0 6px;
  line-height: 18px;
  border-radius: 3px;
  transform-origin: top left;
}

.selectable .frameTypeTag {
  left: 34px;
}

.selectCheck {
  position: absolute;
  left: 6px;
  top: 6px;
  z-index: 5;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.84);
  transform-origin: top left;
}

.timingBadge {
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 6px;
  z-index: 2;
  max-width: calc(100% - 12px);
  padding: 0 6px;
  line-height: 18px;
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.58);
  transform-origin: bottom left;
  pointer-events: none;
}

.addBetween {
  position: absolute;
  top: 50%;
  z-index: 10;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--td-brand-color, #0052d9);
  border: 1px solid rgba(255, 255, 255, 0.28);
  color: #fff;
  box-shadow: none;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    background-color 0.16s ease;

  &:hover {
    background: var(--td-brand-color-hover, #366ef4);
  }

  &--left {
    transform: translate(calc(-50% - 4px), -50%);
  }

  &--right {
    right: 0;
    transform: translate(calc(50% + 4px), -50%);
  }
}

.imageToolsWrap {
  position: absolute;
  right: 4px;
  bottom: 4px;
  z-index: 3;
  contain: layout style;
}

.actionBtn {
  position: absolute;
  z-index: 4;
  padding: 5px;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transform-origin: center;
}

.remove {
  top: 3px;
  right: 3px;
  background-color: rgba(220, 50, 50, 0.7);

  &:hover {
    background-color: rgba(220, 50, 50, 1);
  }
}

.editNode {
  bottom: 3px;
  left: 3px;
  background-color: rgba(24, 144, 255, 0.7);

  &:hover {
    background-color: rgba(24, 144, 255, 1);
  }
}
</style>
