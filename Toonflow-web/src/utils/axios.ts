import axios from "axios";
import router from "@/router/index";
import { storeToRefs } from "pinia";
import { MessagePlugin } from "tdesign-vue-next";
import settingStore from "@/stores/setting";

const instance = axios.create();

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
    if (error.status === 401) {
      localStorage.removeItem("token");
      router.push("/login");
      MessagePlugin.error(window.$t("common.sessionExpired"));
    }
    return Promise.reject(error?.response?.data ?? error);
  },
);

export default instance;
