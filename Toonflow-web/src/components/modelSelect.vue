<template>
  <t-select
    :size="props.size"
    v-model="selectValue"
    :placeholder="props.placeholder ?? $t('components.modelSelect.placeholder')"
    @change="onChange"
    @popup-visible-change="onPopupVisibleChange">
    <t-option-group v-for="(list, index) in optionsData" :key="index" :label="list.group">
      <t-option v-for="item in list.children" :key="item.id" :value="`${item.id}:${item.value}`" :label="item.label">
        <div v-if="!props.simple" class="optionItem">
          <div class="optionMain">
            <t-avatar v-if="item.logo" size="24px" shape="round" :image="item.logo" />
            <t-avatar v-else size="24px" shape="round" class="fallbackAvatar">{{ getFallbackText(item.label) }}</t-avatar>
            <div class="optionLabel">{{ item.label }}</div>
          </div>
          <span class="optionType">{{ item.type }}</span>
        </div>
      </t-option>
    </t-option-group>
    <!-- 无可用模型时，显示跳转设置的按钮 -->
    <template #empty>
      <div class="emptyActionWrap">
        <t-button class="emptyActionButton" size="small" variant="text" theme="primary" @click.stop="goVendorConfig">
          {{ $t("components.modelSelect.goSetting") }}
        </t-button>
      </div>
    </template>
  </t-select>
</template>

<script setup lang="ts">
import { providersLogo, modelProviderRules } from "@/utils/providersLogo";
import settingStore from "@/stores/setting";

import axios from "@/utils/axios";
interface VendorChild {
  id: number;
  label: string;
  value: string;
  vendorId: number;
  type: string;
  logo?: string | null;
}

interface VendorOption {
  group: string;
  id: number;
  children: VendorChild[];
}
const selectValue = defineModel({
  type: String,
  default: "",
});

const selectValueLabel = defineModel("label");

const props = defineProps({
  type: {
    type: String as () => "text" | "image" | "all" | "video",
    default: "all",
  },
  size: {
    type: String as () => "small" | "medium" | "large",
    default: "medium",
  },
  placeholder: {
    type: String,
  },
  changeConfig: {
    type: Boolean,
    default: false,
  },
  simple: {
    type: Boolean,
    default: false,
  },
});
const emit = defineEmits<{
  change: [value: string, data?: any];
}>();

async function onChange(value: any, { option }: any) {
  selectValue.value = value;
  selectValueLabel.value = option.label;
  if (props.changeConfig) {
    const { data } = await axios.post("/modelSelect/getModelDetail", {
      modelId: value,
    });
    emit("change", value, data);
  } else {
    emit("change", value);
  }
}
const optionsData = ref<VendorOption[]>([]);
const modelOptionsCache = new Map<string, VendorOption[]>();
const modelOptionsPending = new Map<string, Promise<VendorOption[]>>();
onMounted(() => {
  void handleModelChange();
});

function onPopupVisibleChange(visible: boolean) {
  if (visible && !optionsData.value.length) {
    void handleModelChange();
  }
}
const titleMap = {
  image: $t("components.modelSelect.type.image"),
  text: $t("components.modelSelect.type.text"),
  video: $t("components.modelSelect.type.video"),
};
//获取模型选择API数据
function buildOptionGroups(responseData: any[]) {
  const groupMap = new Map<string, VendorOption>();
  responseData.forEach((item: any) => {
    const groupKey = item.id;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        group: item.name,
        id: item.id,
        children: [],
      });
    }
    groupMap.get(groupKey)!.children.push({
      id: item.id,
      label: item.label,
      value: item.value,
      vendorId: item.vendorId,
      type: titleMap[item.type as "image" | "text" | "video"],
      logo: getProviderLogoByModel(item.label, item.value),
    });
  });
  return Array.from(groupMap.values());
}

function syncSelectedValue() {
  if (
    optionsData.value
      .map((i) => i.children)
      .flat()
      .every((i) => `${i.id}:${i.value}` !== selectValue.value)
  ) {
    selectValue.value = "";
  }
}

async function handleModelChange(force = false) {
  const cacheKey = props.type;
  if (!force) {
    const cached = modelOptionsCache.get(cacheKey);
    if (cached?.length) {
      optionsData.value = cached;
      syncSelectedValue();
      return;
    }
    const pending = modelOptionsPending.get(cacheKey);
    if (pending) {
      optionsData.value = await pending;
      syncSelectedValue();
      return;
    }
  }

  const request = axios
    .post("/modelSelect/getModelList", { type: props.type })
    .then((response) => {
      const groups = buildOptionGroups(response.data);
      modelOptionsCache.set(cacheKey, groups);
      return groups;
    })
    .catch((error) => {
      console.error($t("components.modelSelect.msg.fetchModelFailed"), error);
      return [] as VendorOption[];
    })
    .finally(() => {
      modelOptionsPending.delete(cacheKey);
    });

  modelOptionsPending.set(cacheKey, request);
  optionsData.value = await request;
  syncSelectedValue();
}

function getProviderLogoByModel(label?: string, value?: string) {
  const source = `${label || ""} ${value || ""}`.trim();
  if (!source) return null;
  const matchedRule = modelProviderRules.find((rule) => rule.pattern.test(source));
  return matchedRule ? providersLogo[matchedRule.provider] : null;
}

function getFallbackText(label: string) {
  return label?.slice(0, 1)?.toUpperCase() || "M";
}

function goVendorConfig() {
  const store = settingStore();
  store.activeMenu = "vendorConfig";
  store.showSetting = true;
}
</script>

<style lang="scss" scoped>
.optionItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.optionMain {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.optionLabel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.optionType {
  color: var(--td-text-color-secondary);
  flex-shrink: 0;
}

.fallbackAvatar {
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.emptyActionWrap {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
  .emptyActionButton {
    min-width: 140px;
    color: #339af0;
  }
}
</style>
