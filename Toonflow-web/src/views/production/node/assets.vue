<template>
  <t-card class="assets">
    <Handle :id="props.handleIds.target" type="target" :position="Position.Top" />
    <div class="titleBar dragHandle">
      <div class="title">{{ $t("workbench.production.node.assets.title") }}</div>
    </div>
    <div class="content">
      <div class="cardGrid">
        <div v-for="asset in assets" :key="asset.id" class="assetItemBox">
          <t-card class="assetCard">
            <div
              v-if="asset.src"
              class="assetImageWrap"
              @mouseenter="hoveredAssetId = asset.id"
              @mouseleave="hoveredAssetId = null">
              <img
                :src="getAssetDisplaySrc(asset.src, asset.thumbSrc)"
                :alt="asset.name"
                class="assetImage"
                loading="lazy"
                decoding="async" />
              <div v-if="hoveredAssetId === asset.id" class="imageToolsWrap">
                <ImageTools :src="asset.src" position="br" />
              </div>
            </div>
            <div v-else class="assetImageWrap assetImagePlaceholder">
              <t-loading v-if="asset.state == '生成中'" size="small" />
              <span v-else-if="asset.state == '生成失败'" style="color: red">{{ $t("workbench.production.node.assets.generateFailed") }}</span>
              <t-empty v-else size="small" :title="$t('workbench.production.node.assets.notGenerated')" />
            </div>
            <div class="cardInfo">
              <div class="cardName">
                <span class="nameText">{{ asset.name }}</span>
                <t-tag theme="success">{{ $t("workbench.production.node.assets.originalAsset") }}</t-tag>
              </div>
              <div class="cardDesc">{{ asset.desc }}</div>
            </div>
          </t-card>
          <div class="divider">
            <i-right size="32"></i-right>
          </div>
          <div class="deriveAssets">
            <t-card v-for="(item, index) in asset.derive" :key="index" class="assetCard" @click="generateAssetsImage(item, asset.src)">
              <div
                v-if="item.src && item.state == '已完成'"
                class="assetImageWrap"
                @mouseenter="hoveredDeriveId = item.id"
                @mouseleave="hoveredDeriveId = null">
                <img
                  :src="getAssetDisplaySrc(item.src, item.thumbSrc)"
                  :alt="item.name"
                  class="assetImage"
                  loading="lazy"
                  decoding="async" />
                <div v-if="hoveredDeriveId === item.id" class="imageToolsWrap">
                  <ImageTools :src="item.src" position="br" />
                </div>
              </div>
              <div v-else class="assetImageWrap assetImagePlaceholder">
                <t-loading v-if="item.state == '生成中'" size="small" />
                <t-tooltip v-else-if="item.state == '生成失败'" :content="item?.errorReason">
                  <div style="color: red; cursor: pointer">{{ $t("workbench.novel.genFailed") }}</div>
                </t-tooltip>
                <t-empty v-else size="small" :title="$t('workbench.production.node.assets.notGenerated')" />
              </div>
              <t-tooltip theme="primary" :content="$t('workbench.production.node.storyboard.deleteNode')">
                <div class="remove ac" @click.stop="removeFn(item.id!)">
                  <i-delete theme="outline" size="18" fill="#fff" />
                </div>
              </t-tooltip>
              <div class="cardInfo">
                <div class="cardName">
                  <span class="nameText">{{ item.name }}</span>
                  <t-tag theme="warning">{{ $t("workbench.production.node.assets.derived") }}</t-tag>
                </div>
                <div class="cardDesc">{{ item.desc }}</div>
              </div>
            </t-card>
            <t-card v-if="asset.derive.length <= 0" class="assetCard emptyCard">
              <t-empty :title="$t('workbench.production.node.assets.noDerivedAssets')"></t-empty>
            </t-card>
          </div>
        </div>
      </div>
    </div>
    <editImage v-model="visible" v-if="visible" :flowData="currentRow" @save="save" />
  </t-card>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { type AssetItem, type DeriveAsset } from "../utils/flowBuilder";
import { buildTencentCosPreviewUrl, getPreviewImageSrc } from "../utils/imagePreview";
import axios from "@/utils/axios";
import useProjectStore from "@/stores/project";
const { project } = storeToRefs(useProjectStore());
const editImage = defineAsyncComponent(() => import("../components/editImage/index.vue"));
const ImageTools = defineAsyncComponent(() => import("@/components/imageTools.vue"));
const props = defineProps<{
  id: string;
  handleIds: {
    target: string;
  };
}>();

const assets = defineModel<AssetItem[]>({ required: true });
const currentRow = ref<{
  flowId?: number;
  resultImages: { src: string; prompt: string }[];
  referanceImages: string[];
}>({
  resultImages: [],
  referanceImages: [],
});
const visible = ref(false);
const currentAssetsId = ref();
const hoveredAssetId = ref<number | null>(null);
const hoveredDeriveId = ref<number | null>(null);

function getAssetDisplaySrc(src?: string | null, thumbSrc?: string | null) {
  return getPreviewImageSrc(thumbSrc, src, { width: 480, format: "webp" });
}

function generateAssetsImage(row: DeriveAsset, referanceImageUrl?: string) {
  currentRow.value = {
    flowId: row?.flowId,
    resultImages: [{ src: row.src, prompt: row.prompt }],
    referanceImages: referanceImageUrl ? [referanceImageUrl] : [],
  };
  currentAssetsId.value = row.id;
  visible.value = true;
}

async function save({ imageUrl, flowId }: { imageUrl: string; flowId: number }) {
  // 更新对应分镜的 src
  if (!imageUrl) return;
  const previewUrl = buildTencentCosPreviewUrl(imageUrl, { width: 480, format: "webp" });
  for (const i of assets.value) {
    const target = i.derive.find((s) => s.id === currentAssetsId.value);
    if (target) {
      target.state = "已完成";
      target.src = imageUrl;
      target.thumbSrc = previewUrl;
      target.flowId = flowId;
      break;
    }
  }

  await axios.post("/production/assets/updateAssetsUrl", {
    id: currentAssetsId.value,
    url: imageUrl,
    flowId,
  });
}

async function removeFn(id: number) {
  const dialog = DialogPlugin.confirm({
    header: $t("workbench.assets.confirmDeleteHeader"),
    body: $t("workbench.production.node.assets.confirmDeleteBody"),
    confirmBtn: $t("workbench.assets.deleteBtn"),
    cancelBtn: $t("workbench.assets.cancelBtn"),
    theme: "warning",
    onConfirm: async () => {
      try {
        await axios.post("/production/assets/deleteAssetsDireve", {
          id,
          projectId: project.value?.id,
        });
        //找到对应子资产删除
        assets.value.forEach((item) => {
          const targetIndex = item.derive.findIndex((s) => s.id === id);
          if (targetIndex !== -1) {
            item.derive.splice(targetIndex, 1);
          }
        });
      } catch (e) {
        window.$message.error((e as any)?.message || $t("workbench.production.node.assets.removeFailed"));
      } finally {
        dialog.destroy();
      }
    },
  });
}
</script>

<style lang="scss" scoped>
.assets {
  width: fit-content;
  user-select: text;
  cursor: default;
  contain: layout style;

  .titleBar {
    cursor: grab;
    user-select: none;

    .title {
      background-color: #000;
      width: fit-content;
      padding: 5px 10px;
      color: #fff;
      border-radius: 8px 0;
      font-size: 16px;
    }
  }

  .content {
    margin-top: 8px;

    .cardGrid {
      display: flex;
      flex-direction: column;
      contain: layout style;

      .assetItemBox {
        display: flex;
        align-items: stretch;
        gap: 12px;
        padding: 10px;
        content-visibility: auto;
        contain: layout style;
        contain-intrinsic-size: auto 250px;

        &:not(:first-child) {
          margin-top: 8px;
        }

        .assetCard {
          width: 200px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          contain: layout style;

          &:hover {
            .remove {
              opacity: 1;
            }
          }

          .assetImageWrap {
            position: relative;
            width: 100%;
            aspect-ratio: 1 / 1;
            border-radius: 4px;
            overflow: hidden;
            background-color: var(--td-bg-color-container-hover, #f5f5f5);
            contain: layout style;

            &.assetImagePlaceholder {
              display: flex;
              align-items: center;
              justify-content: center;
            }

            .assetImage {
              display: block;
              width: 100%;
              height: 100%;
              object-fit: contain;
            }

            .imageToolsWrap {
              position: absolute;
              inset: 0;
              display: flex;
              align-items: flex-end;
              justify-content: flex-end;
            }
          }

          .cardInfo {
            margin-top: 8px;

            .cardName {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 13px;
              font-weight: 600;
              color: #333;

              .nameText {
                text-overflow: ellipsis;
                white-space: nowrap;
                overflow: hidden;
                max-width: 120px;
              }
            }

            .cardDesc {
              font-size: 11px;
              color: #999;
              display: -webkit-box;
              -webkit-line-clamp: 2;
              -webkit-box-orient: vertical;
              overflow: hidden;
            }
          }
        }

        .divider {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        .deriveAssets {
          display: flex;
          align-items: stretch;
          gap: 12px;

          .remove {
            position: absolute;
            top: 3px;
            right: 3px;
            z-index: 9999;
            padding: 5px;
            border-radius: 10px;
            background-color: rgba(220, 50, 50, 0.7);
            cursor: pointer;
            opacity: 0;
            &:hover {
              background-color: rgba(220, 50, 50, 1);
            }
          }
          .emptyCard {
            display: flex;
            align-items: center;
            justify-content: center;

            :deep(.t-card__body) {
              width: 100%;
              height: 100%;
              display: flex;
              align-items: center;
              justify-content: center;
            }
          }
        }
      }
    }
  }
}
</style>
