import { createApp } from "vue";
import { createPinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import App from "./App.vue";
import router from "./router";
import i18n, { initializeLocale } from "./locales";
import "@icon-park/vue-next/styles/index.css";
import { registerIconPark } from "./iconPark";

import "tdesign-vue-next/es/style/index.css";
import { LoadingDirective, LoadingPlugin } from "tdesign-vue-next";

import "@/utils/global";

import "./assets/main.scss";

async function bootstrap() {
  await initializeLocale();

  const app = createApp(App);
  registerIconPark(app);
  app.use(createPinia().use(piniaPluginPersistedstate));
  app.use(router);
  app.use(i18n);
  app.use(LoadingPlugin);
  app.directive("loading", LoadingDirective);
  app.mount("#app");
}

void bootstrap();
