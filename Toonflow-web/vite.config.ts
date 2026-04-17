import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { TDesignResolver } from "@tdesign-vue-next/auto-import-resolver";
import { viteSingleFile } from "vite-plugin-singlefile";
import postcsspxtoviewport from "postcss-px-to-viewport";

const useSingleFile = process.env.VITE_SINGLEFILE !== "0";

function manualChunks(id: string) {
  if (useSingleFile || !id.includes("node_modules")) return undefined;

  if (id.includes("monaco-editor")) return "vendor-monaco";
  if (
    id.includes("md-editor-v3") ||
    id.includes("@codemirror") ||
    id.includes("@lezer") ||
    id.includes("codemirror") ||
    id.includes("markdown-it") ||
    id.includes("medium-zoom") ||
    id.includes("lucide-vue-next") ||
    id.includes("@vavt") ||
    id.includes("xss") ||
    id.includes("mermaid") ||
    id.includes("highlight.js") ||
    id.includes("katex")
  ) {
    return "vendor-markdown";
  }
  if (id.includes("@webav") || id.includes("vue-clip-track") || id.includes("splitpanes")) return "vendor-video-editor";
  if (id.includes("@vue-flow") || id.includes("@dagrejs/dagre")) return "vendor-flow";
  if (id.includes("tdesign-vue-next") || id.includes("@tdesign-vue-next/chat")) return "vendor-tdesign";
  if (id.includes("@icon-park") || id.includes("@devui-design/icons")) return "vendor-icons";
  if (id.includes("socket.io-client")) return "vendor-socket";
  if (id.includes("mammoth") || id.includes("jszip")) return "vendor-doc";
  if (
    id.includes("pinia") ||
    id.includes("pinia-plugin-persistedstate") ||
    id.includes("vue-router") ||
    id.includes("vue-i18n") ||
    id.includes("@vueuse")
  ) {
    return "vendor-app";
  }
  if (id.includes("/vue/") || id.includes("@vue/")) return "vendor-vue";
  if (id.includes("axios") || id.includes("dayjs") || id.includes("lodash") || id.includes("uuid") || id.includes("p-limit")) {
    return "vendor-utils";
  }

  return "vendor";
}

export default defineConfig({
  base: "./",
  build: {
    modulePreload: false,
    cssCodeSplit: false,
    ...(useSingleFile ? { assetsInlineLimit: Infinity } : {}),
    rollupOptions: {
      output: {
        inlineDynamicImports: useSingleFile,
        ...(useSingleFile ? {} : { manualChunks }),
      },
    },
  },
  plugins: [
    vue(),
    AutoImport({
      dts: "src/types/auto-imports.d.ts",
      imports: ["vue", "pinia", "vue-router"],
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
        TDesignResolver({
          library: "chat",
        }),
      ],
    }),
    Components({
      dts: "src/types/components.d.ts",
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
        TDesignResolver({
          library: "chat",
        }),
      ],
    }),
    ...(useSingleFile ? [viteSingleFile()] : []),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: "modern-compiler",
      },
    },
    postcss: {
      plugins: [
        postcsspxtoviewport({
          // 要转化的单位
          unitToConvert: "px",
          // UI设计稿的大小
          viewportWidth: 1600,
          // 转换后的精度
          unitPrecision: 4,
          // 转换后的单位
          viewportUnit: "rem",
          // 字体转换后的单位
          fontViewportUnit: "rem",
          // 能转换的属性，*表示所有属性，!border表示border不转
          propList: ["*"],
          // 指定不转换为视窗单位的类名，
          selectorBlackList: ["ignore"],
          // 最小转换的值，小于等于1不转
          minPixelValue: 1,
          // 是否在媒体查询的css代码中也进行转换，默认false
          mediaQuery: true,
          // 是否转换后直接更换属性值
          replace: true,
          // 忽略某些文件夹下的文件或特定文件，例如 'node_modules' 下的文件
          exclude: [],
          // 包含那些文件或者特定文件
          include: [],
          // 是否处理横屏情况
          landscape: false,
        }),
      ],
    },
  },
  server: {
    port: 50188,
  },
});
