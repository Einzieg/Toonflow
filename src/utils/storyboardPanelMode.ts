export type StoryboardPanelMode = "text" | "imageReference" | "singleImage";

export const storyboardPanelModeLabel: Record<StoryboardPanelMode, string> = {
  text: "纯文本模式",
  imageReference: "图片参考模式",
  singleImage: "单图模式",
};

function parseProjectVideoMode(value: any): any {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function flattenModeTokens(value: any): string[] {
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value)) return value.flatMap((item) => flattenModeTokens(item));
  return [];
}

function isGrokImagineVideo15Preview(projectData: any, modelDetail: any) {
  const value = `${projectData?.videoModel ?? ""} ${modelDetail?.modelName ?? ""} ${modelDetail?.name ?? ""}`.toLowerCase().replace(/\s+/g, "");
  return value.includes("grok-imagine-video-1.5-preview") || value.includes("grokimaginevideo1.5preview");
}

function modeHasReferenceImages(value: any): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => Array.isArray(item) || modeHasReferenceImages(item));
  }
  return typeof value === "string" && /(image|video|audio|text)?reference:\d+|^image$|^video$|^audio$/.test(value.toLowerCase());
}

export function resolveStoryboardPanelMode(
  projectData: any,
  modelDetail: any,
  requestedMode: StoryboardPanelMode | "auto" = "auto",
): { mode: StoryboardPanelMode; label: string; reason: string } {
  if (requestedMode !== "auto") {
    return {
      mode: requestedMode,
      label: storyboardPanelModeLabel[requestedMode],
      reason: "工具参数指定",
    };
  }

  if (isGrokImagineVideo15Preview(projectData, modelDetail)) {
    return {
      mode: "singleImage",
      label: storyboardPanelModeLabel.singleImage,
      reason: "Grok Imagine Video 1.5 Preview 只走单图图生视频",
    };
  }

  const selectedMode = parseProjectVideoMode(projectData?.mode);
  const selectedTokens = flattenModeTokens(selectedMode);
  const selectedHasMode = selectedTokens.length > 0;
  if (selectedHasMode) {
    if (selectedTokens.includes("text") && !modeHasReferenceImages(selectedMode) && !selectedTokens.includes("singleimage")) {
      return {
        mode: "text",
        label: storyboardPanelModeLabel.text,
        reason: "项目视频模式为 text",
      };
    }
    if (selectedTokens.includes("singleimage")) {
      return {
        mode: "singleImage",
        label: storyboardPanelModeLabel.singleImage,
        reason: "项目视频模式为 singleImage",
      };
    }
    if (Array.isArray(selectedMode) || modeHasReferenceImages(selectedMode)) {
      return {
        mode: "imageReference",
        label: storyboardPanelModeLabel.imageReference,
        reason: "项目视频模式为多图片/多模态参考",
      };
    }
    if (selectedTokens.some((token) => /frame/.test(token))) {
      return {
        mode: "singleImage",
        label: storyboardPanelModeLabel.singleImage,
        reason: "项目视频模式为首帧/尾帧类图片输入",
      };
    }
  }

  const modelMode = parseProjectVideoMode(modelDetail?.mode);
  const modelTokens = flattenModeTokens(modelMode);
  if (modelTokens.includes("text") && !modeHasReferenceImages(modelMode) && !modelTokens.includes("singleimage")) {
    return {
      mode: "text",
      label: storyboardPanelModeLabel.text,
      reason: "模型仅声明 text 模式",
    };
  }
  if (modeHasReferenceImages(modelMode)) {
    return {
      mode: "imageReference",
      label: storyboardPanelModeLabel.imageReference,
      reason: "模型声明支持多参考图",
    };
  }
  if (modelTokens.includes("singleimage") || modelTokens.some((token) => /frame/.test(token))) {
    return {
      mode: "singleImage",
      label: storyboardPanelModeLabel.singleImage,
      reason: "模型声明支持单图/首帧输入",
    };
  }

  return {
    mode: "text",
    label: storyboardPanelModeLabel.text,
    reason: "未检测到图片输入能力",
  };
}
