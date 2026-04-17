import axios from "axios";
import router from "@/router/index";
import { storeToRefs } from "pinia";
import { MessagePlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";

const instance = axios.create();

function isLoopbackHost(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveBaseUrl(baseUrl: string, isElectron: boolean) {
  if (typeof window === "undefined" || isElectron) {
    return baseUrl || "/api";
  }

  const fallback = `${window.location.origin}/api`;
  const normalized = String(baseUrl || "").trim();
  if (!normalized) return fallback;

  try {
    const currentUrl = new URL(window.location.href);
    const resolvedUrl = new URL(normalized, currentUrl.origin);
    if (!isLoopbackHost(currentUrl.hostname) && isLoopbackHost(resolvedUrl.hostname)) {
      return fallback;
    }
    return normalized.startsWith("/") ? normalized : `${resolvedUrl.origin}${resolvedUrl.pathname}${resolvedUrl.search}${resolvedUrl.hash}`;
  } catch {
    return fallback;
  }
}

instance.interceptors.request.use(function (config) {
  const { baseUrl, otherSetting, isElectron } = storeToRefs(settingStore());
  config.baseURL = resolveBaseUrl(baseUrl.value, isElectron.value);
  config.timeout = otherSetting.value.axiosTimeOut;
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = token;
  }
  return config;
});

instance.interceptors.response.use(
  function (response) {
    return response.data;
  },
  function (error) {
    if (error.status === 401) {
      localStorage.removeItem("token");
      router.push("/login");
      MessagePlugin.error(window.$t("common.sessionExpired"));
    }
    return Promise.reject(error?.response?.data ?? error);
  },
);

export default instance;
