<template>
  <t-dialog :header="$t('settings.title')" :footer="false" placement="center" width="1200px" v-model:visible="showSetting">
    <div class="settingPanel">
      <t-menu class="settingMenu" v-model:value="activeMenu" :style="{ height: '70vh' }">
        <t-menu-item v-for="item in menuItems" :key="item.key" :value="item.key">
          <template #icon>
            <t-badge :count="needUpdate && item.key === 'about' ? 1 : 0" dot>
              <component :is="item.icon" class="icon" />
            </t-badge>
          </template>
          {{ $t(item.label) }}
        </t-menu-item>
      </t-menu>
      <div class="settingRight">
        <div class="sectionTitle">{{ currentMenuItem ? $t(currentMenuItem.label) : "" }}</div>
        <div class="settingContent">
          <component :is="currentSettingComponent" v-if="currentSettingComponent" />
        </div>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import settingStore from "@/stores/setting";
const { showSetting, activeMenu, needUpdate } = storeToRefs(settingStore());

const settingComponentMap = {
  ui: defineAsyncComponent(() => import("./components/uiConfig.vue")),
  language: defineAsyncComponent(() => import("./components/languageConfig.vue")),
  vendorConfig: defineAsyncComponent(() => import("./components/vendorConfig.vue")),
  modelMap: defineAsyncComponent(() => import("./components/modelMap.vue")),
  agentConfog: defineAsyncComponent(() => import("./components/agentConfog.vue")),
  promptManage: defineAsyncComponent(() => import("./components/promptManage.vue")),
  skillManagement: defineAsyncComponent(() => import("./components/skillManagement.vue")),
  memoryConfig: defineAsyncComponent(() => import("./components/memoryConfig.vue")),
  loginConfig: defineAsyncComponent(() => import("./components/loginConfig.vue")),
  dbConfig: defineAsyncComponent(() => import("./components/dbConfig.vue")),
  fileManagement: defineAsyncComponent(() => import("./components/fileManagement.vue")),
  otherConfig: defineAsyncComponent(() => import("./components/otherConfig.vue")),
  requestConfig: defineAsyncComponent(() => import("./components/requestConfig.vue")),
  devConfig: defineAsyncComponent(() => import("./components/devConfig.vue")),
  about: defineAsyncComponent(() => import("./components/about.vue")),
  logoutConfig: defineAsyncComponent(() => import("./components/logoutConfig.vue")),
} as const;

const menuItems = [
  { key: "ui", label: "settings.menu.ui", icon: "i-theme" },
  { key: "language", label: "settings.menu.language", icon: "i-translate" },
  { key: "vendorConfig", label: "settings.menu.vendorConfig", icon: "i-computer" },
  { key: "modelMap", label: "settings.menu.modelMap", icon: "i-computer" },
  { key: "agentConfog", label: "settings.menu.agentConfig", icon: "i-color-filter" },
  { key: "promptManage", label: "settings.menu.promptManage", icon: "i-tips" },
  { key: "skillManagement", label: "settings.menu.skillsSkillsManagement", icon: "i-ring" },
  { key: "memoryConfig", label: "settings.menu.memoryConfig", icon: "i-memory-card-one" },
  { key: "loginConfig", label: "settings.menu.loginConfig", icon: "i-lock" },
  { key: "dbConfig", label: "settings.menu.dbConfig", icon: "i-data" },
  { key: "fileManagement", label: "settings.menu.fileManagement", icon: "i-hard-disk" },
  { key: "otherConfig", label: "settings.menu.otherConfig", icon: "i-application-menu" },
  { key: "requestConfig", label: "settings.menu.requestConfig", icon: "i-api" },
  { key: "devConfig", label: "settings.menu.devConfig", icon: "i-flask" },
  { key: "about", label: "settings.menu.about", icon: "i-info" },
  { key: "logoutConfig", label: "settings.menu.logoutConfig", icon: "i-logout" },
];

const currentMenuItem = computed(() => menuItems.find((item) => item.key === activeMenu.value));
const currentSettingComponent = computed(() => settingComponentMap[activeMenu.value as keyof typeof settingComponentMap] ?? null);
</script>

<style lang="scss" scoped>
.settingPanel {
  display: flex;
  height: 70vh;
  overflow: hidden;

  .settingMenu {
    width: 200px;
    min-width: 200px;
    border-right: 1px solid var(--td-component-border);
    flex-shrink: 0;
    .icon {
      font-size: 20px;
      margin-right: 8px;
    }
  }

  .settingRight {
    flex: 1;
    padding-left: 16px;
    padding-right: 16px;
    height: 70vh;
    overflow-y: auto;

    .sectionTitle {
      font-size: 16px;
      font-weight: 600;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--td-component-border);
      margin-bottom: 1vh;
      height: 4vh;
    }

    .settingContent {
      width: 100%;
      height: calc(70vh - 5vh - 4px);
    }
  }
}
:deep(.t-menu) {
  padding: 0;
  padding-right: 8px;
}
:deep(.t-is-active) {
  .t-badge {
    color: var(--td-brand-color) !important;
  }
}
</style>
