<template>
  <titleBar v-if="isElectron" />
  <t-config-provider :global-config="globalConfig">
    <router-view></router-view>
  </t-config-provider>
</template>

<script setup lang="ts">
import settingStore from "@/stores/setting";
import zhConfig from "tdesign-vue-next/es/locale/zh_CN";
import enConfig from "tdesign-vue-next/es/locale/en_US";
import { cachedLocale } from "@/locales";
import { initTheme } from "@/utils/theme";
import { type GlobalConfigProvider } from "tdesign-vue-next";
const { baseUrl, isElectron } = storeToRefs(settingStore());

watch(
  () => isElectron.value,
  (newVal) => {
    if (newVal) {
      document.body.classList.add("is-electron");
    } else {
      document.body.classList.remove("is-electron");
    }
  },
  { immediate: true },
);

onBeforeMount(() => {
  document.addEventListener("keydown", function (event) {
    if (event.key === "F8") {
      event.preventDefault();
      debugger;
    }
  });
});

// 初始化主题
onMounted(() => {
  normalizeWebBaseUrl();
  getPort();
});

function isLoopbackHost(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function getCurrentApiBaseUrl() {
  if (typeof window === "undefined") return "/api";
  return `${window.location.origin}/api`;
}

function normalizeWebBaseUrl() {
  if (typeof window === "undefined" || isElectron.value) return;

  const normalized = String(baseUrl.value || "").trim();
  if (!normalized) {
    baseUrl.value = getCurrentApiBaseUrl();
    return;
  }

  try {
    const currentUrl = new URL(window.location.href);
    const resolvedUrl = new URL(normalized, currentUrl.origin);
    if (!isLoopbackHost(currentUrl.hostname) && isLoopbackHost(resolvedUrl.hostname)) {
      baseUrl.value = getCurrentApiBaseUrl();
    }
  } catch {
    baseUrl.value = getCurrentApiBaseUrl();
  }
}

async function handleLinkClick(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();

  const target = event.currentTarget as HTMLAnchorElement | null;
  const url = target?.getAttribute("data-link") || target?.getAttribute("href");
  if (!url || !isExternalUrl(url)) return false;

  await openExternalUrl(url);

  return false;
}

function isExternalUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.href);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function openExternalUrl(url: string) {
  if (!isExternalUrl(url)) return;

  if (isElectron.value) {
    await fetch(`toonflow://openurlwithbrowser?url=${encodeURIComponent(url)}`);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function handleDocumentClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
  const url = anchor?.getAttribute("href");
  if (!anchor || !url || !isExternalUrl(url)) return;

  event.preventDefault();
  event.stopPropagation();
  void openExternalUrl(url);
}

onMounted(() => {
  (window as any).handleLinkClick = handleLinkClick;
  document.addEventListener("click", handleDocumentClick, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClick, true);
});

async function getPort() {
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
  try {
    const res = await fetch("toonflow://getAppUrl");
    const data = await res.json();
    if (data?.url) {
      baseUrl.value = data.url;
      isElectron.value = true;
    }
  } catch (error) {}
}

const tdesignLocaleMap: Record<string, object> = {
  "zh-CN": zhConfig,
  en: enConfig,
};

const customConfig: GlobalConfigProvider = {
  calendar: {},
  table: {},
  pagination: {},
};

function mergeGlobalConfig(localeConfig: GlobalConfigProvider): GlobalConfigProvider {
  return {
    ...localeConfig,
    ...customConfig,
    calendar: {
      ...(localeConfig.calendar ?? {}),
      ...(customConfig.calendar ?? {}),
    },
    table: {
      ...(localeConfig.table ?? {}),
      ...(customConfig.table ?? {}),
    },
    pagination: {
      ...(localeConfig.pagination ?? {}),
      ...(customConfig.pagination ?? {}),
    },
  };
}

const globalConfig = computed<GlobalConfigProvider>(() => mergeGlobalConfig((tdesignLocaleMap[cachedLocale.value] || zhConfig) as GlobalConfigProvider));

onBeforeMount(() => {
  initTheme();
});
</script>

<style lang="scss"></style>
