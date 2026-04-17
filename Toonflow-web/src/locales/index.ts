import { createI18n } from "vue-i18n";
import { useLocalStorage } from "@vueuse/core";

const DEFAULT_LOCALE = "zh-CN";
const FALLBACK_LOCALE = "en";

const localeLoaders = {
  "zh-CN": () => import("./language/zh-CN.json"),
  "zh-TW": () => import("./language/zh-TW.json"),
  en: () => import("./language/en.json"),
  "th-TH": () => import("./language/th_TH.json"),
  "vi-VN": () => import("./language/vi-VN.json"),
  "ja-JP": () => import("./language/ja_JP.json"),
  "ru-RU": () => import("./language/ru_RU.json"),
} as const;

type LocaleKey = keyof typeof localeLoaders;

const languageList = [
  { label: "简体中文", tips: "Chinese (Simplified)", value: "zh-CN" },
  { label: "繁體中文", tips: "Chinese (Traditional)", value: "zh-TW" },
  { label: "English", tips: "English", value: "en" },
  { label: "ไทย", tips: "Thai", value: "th-TH" },
  { label: "Tiếng Việt", tips: "Vietnamese", value: "vi-VN" },
  { label: "日本語", tips: "Japanese", value: "ja-JP" },
  { label: "Русский", tips: "Russian", value: "ru-RU" },
];

const cachedLocale = useLocalStorage<LocaleKey>("locale", DEFAULT_LOCALE);
const loadedLocales = new Set<LocaleKey>();

const i18n = createI18n({
  legacy: false,
  locale: cachedLocale.value,
  fallbackLocale: FALLBACK_LOCALE,
  messages: {},
});

function normalizeLocale(locale?: string): LocaleKey {
  if (locale && locale in localeLoaders) {
    return locale as LocaleKey;
  }
  return DEFAULT_LOCALE;
}

export async function ensureLocaleMessage(locale?: string) {
  const nextLocale = normalizeLocale(locale);
  if (loadedLocales.has(nextLocale)) return nextLocale;

  const messageModule = await localeLoaders[nextLocale]();
  i18n.global.setLocaleMessage(nextLocale, messageModule.default);
  loadedLocales.add(nextLocale);
  return nextLocale;
}

export async function setLocale(locale?: string) {
  const nextLocale = await ensureLocaleMessage(locale);
  if (nextLocale !== FALLBACK_LOCALE) {
    await ensureLocaleMessage(FALLBACK_LOCALE);
  }

  i18n.global.locale.value = nextLocale;
  cachedLocale.value = nextLocale;
  document.documentElement.lang = nextLocale;
  return nextLocale;
}

export async function initializeLocale() {
  return setLocale(cachedLocale.value);
}

export { languageList, cachedLocale };
export default i18n;
