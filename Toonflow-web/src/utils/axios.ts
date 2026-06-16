import axios from "axios";
import router from "@/router/index";
import { storeToRefs } from "pinia";
import { MessagePlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";

const instance = axios.create();
let lastNetworkErrorAt = 0;

function resolveBaseUrl(baseUrl: string, isElectron: boolean) {
  if (isElectron) return baseUrl || "/api";
  return "/api";
}

instance.interceptors.request.use(function (config) {
  const { baseUrl, otherSetting, isElectron } = storeToRefs(settingStore());
  config.baseURL = resolveBaseUrl(baseUrl.value, isElectron.value);
  config.timeout = config.timeout ?? otherSetting.value.axiosTimeOut;
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
    const status = error?.response?.status ?? error?.status;
    if (status === 401) {
      localStorage.removeItem("token");
      router.push("/login");
      MessagePlugin.error(window.$t("common.sessionExpired"));
    }

    const message = String(error?.message || error?.response?.data?.message || "");
    if (message.includes("Network Error")) {
      const now = Date.now();
      if (now - lastNetworkErrorAt > 3000) {
        lastNetworkErrorAt = now;
        const { isElectron } = storeToRefs(settingStore());
        MessagePlugin.error(
          isElectron.value
            ? "网络连接失败：请检查本机后端服务是否已启动，必要时以管理员身份运行或安装 Visual C++ 运行库。"
            : "网络连接失败：请检查当前域名的 /api 反向代理是否正常指向 Toonflow 后端。",
        );
      }
    }

    return Promise.reject(error?.response?.data ?? error);
  },
);

export default instance;
