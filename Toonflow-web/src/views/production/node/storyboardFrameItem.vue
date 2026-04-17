<template>
  <div ref="frameRef" class="storyboardFrameItem" @mouseenter="hovered = true" @mouseleave="hovered = false">
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

        <template v-if="showImage">
          <img
            v-if="shouldMountMedia"
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
}>();

defineEmits<{
  (e: "insert-left"): void;
  (e: "insert-right"): void;
  (e: "open"): void;
  (e: "remove"): void;
  (e: "edit-info"): void;
}>();

const hovered = ref(false);
const frameRef = ref<HTMLElement | null>(null);
const hasIntersected = ref(false);

const showImage = computed(() => Boolean(props.item.src && props.item.state === "已完成"));
const frameLabel = computed(() => `S${String(props.index + 1).padStart(2, "0")}`);
const shouldMountMedia = computed(() => !showImage.value || hasIntersected.value || hovered.value);

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

.frameImg,
.deferredPlaceholder,
.generatingPlaceholder {
  width: 100%;
  height: 100%;
}

.frameImg {
  display: block;
  object-fit: cover;
}

.deferredPlaceholder,
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
