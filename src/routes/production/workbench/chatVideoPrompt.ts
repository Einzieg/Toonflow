import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveEffectiveStoryboardAssetReferences } from "@/utils/effectiveAssetReference";
import { ensureMandarinDialogueLanguageRule } from "@/utils/videoPromptDialogueLanguage";

const router = express.Router();

function normalizeText(value?: string | null) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = normalizeText(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function parseJsonObject(text: string) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  return JSON.parse(candidate);
}

function compactPrompt(value: string) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLegacyVideoDescParts(videoDesc?: string | null) {
  const text = normalizeText(videoDesc).replace(/^（|）$/g, "");
  return text.split("、").map((item) => normalizeText(item)).filter(Boolean);
}

function extractMarkedVideoDescField(videoDesc: string | null | undefined, field: string, nextFields: string[]) {
  const text = normalizeText(videoDesc);
  const nextPattern = nextFields.map((item) => `${item}[：:]`).join("|");
  const pattern = new RegExp(`${field}[：:]\\s*(.*?)(?:${nextPattern ? nextPattern + "|" : ""}$)`);
  return normalizeText(text.match(pattern)?.[1] || "");
}

function extractDialogueFromVideoDesc(videoDesc?: string | null) {
  const text = normalizeText(videoDesc);
  const match = text.match(/台词[：:]\s*(.*?)(?:音效[：:]|关联资产(?:ID)?[：:]|$)/);
  const dialogue = normalizeText(match?.[1] || "");
  if (!dialogue || /^无(?:台词|对白|配音)?[。.!！]?$/i.test(dialogue)) return "";
  return dialogue.replace(/[。；;]\s*$/, "");
}

function uniqueText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(normalizeText).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function extractStoryboardEmotion(videoDesc?: string | null) {
  const marked = extractMarkedVideoDescField(videoDesc, "情绪", ["光影", "台词", "音效", "关联资产", "关联资产ID"]);
  if (marked) return marked;
  return splitLegacyVideoDescParts(videoDesc)[7] || "";
}

function extractStoryboardPlotBeat(videoDesc?: string | null) {
  const picture = extractMarkedVideoDescField(videoDesc, "画面描述", ["场景", "资产", "关联资产", "时长"]);
  const action = extractMarkedVideoDescField(videoDesc, "动作", ["情绪", "光影", "台词", "音效"]);
  const dialogue = extractDialogueFromVideoDesc(videoDesc);
  if (picture || action || dialogue) return normalizeText([picture, action, dialogue].filter(Boolean).join("；"));

  const parts = splitLegacyVideoDescParts(videoDesc);
  return normalizeText([parts[0], parts[6], parts[9]].filter(Boolean).join("；"));
}

function buildBgmCue(items: any[], english: boolean) {
  const emotions = uniqueText(items.map((item) => extractStoryboardEmotion(item.videoDesc)).filter(Boolean)).slice(0, 5);
  const plotBeats = uniqueText(items.map((item) => extractStoryboardPlotBeat(item.videoDesc)).filter(Boolean)).slice(0, 3);
  const emotionText = emotions.length ? emotions.join(" -> ") : english ? "the current story mood" : "当前剧情情绪";
  const plotText = plotBeats.length ? plotBeats.join("；").slice(0, 180) : english ? "the current scene progression" : "当前分镜情节推进";

  if (english) {
    return `Background music/BGM: non-lyrical background score matching the plot mood (${emotionText}) and story beat (${plotText}); low volume under Mandarin dialogue and key sound effects, with subtle rise and fall following the emotional turn.`;
  }
  return `BGM/背景音乐: 根据剧情情绪（${emotionText}）和情节推进（${plotText}）选择无歌词背景配乐，音量低于中文对白、环境音和关键音效，随情绪转折自然增强或回落。`;
}

function ensureBgmCue(prompt: string, items: any[], english: boolean) {
  const text = compactPrompt(prompt);
  if (/(?:\bBGM\b|Background music|背景音乐|配乐)/i.test(text)) return text;
  return compactPrompt([text, buildBgmCue(items, english)].filter(Boolean).join("\n\n"));
}

function formatVoice(asset: any) {
  if (asset.type !== "role") return "";
  return [
    normalizeText(asset.voiceProfile) ? `声线=${normalizeText(asset.voiceProfile)}` : "",
    normalizeText(asset.voiceTone) ? `语气=${normalizeText(asset.voiceTone)}` : "",
    normalizeText(asset.speechRate) ? `语速=${normalizeText(asset.speechRate)}` : "",
  ]
    .filter(Boolean)
    .join("，");
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackId: z.number(),
    message: z.string().min(1),
    currentPrompt: z.string().optional(),
    model: z.string().optional(),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string(),
        }),
      )
      .optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, trackId, message, currentPrompt = "", model = "", history = [] } = req.body as {
      projectId: number;
      scriptId: number;
      trackId: number;
      message: string;
      currentPrompt?: string;
      model?: string;
      history?: { role: "user" | "assistant"; content: string }[];
    };

    try {
      const [project, track, storyboards] = await Promise.all([
        u.db("o_project").where({ id: projectId }).first(),
        u.db("o_videoTrack").where({ id: trackId, projectId, scriptId }).first(),
        u.db("o_storyboard").where({ projectId, scriptId, trackId }).orderBy("index", "asc"),
      ]);
      if (!track) return res.status(404).send(error("未找到当前视频轨道"));

      const storyboardIds = storyboards.map((item: any) => Number(item.id)).filter((id) => Number.isInteger(id));
      const assets = storyboardIds.length ? await resolveEffectiveStoryboardAssetReferences(storyboardIds) : [];
      const assetLines = assets
        .map((asset: any) => {
          const voice = formatVoice(asset);
          return `- ${asset.id} ${asset.type} ${asset.name || asset.baseName || ""}: ${truncateText(asset.describe || asset.prompt || "", 180)}${voice ? `；${voice}` : ""}`;
        })
        .join("\n");
      const storyboardLines = storyboards
        .map((item: any, index: number) => {
          return [
            `#${index + 1} storyboardId=${item.id} duration=${item.duration || ""}s`,
            `videoDesc: ${truncateText(item.videoDesc || "", 520)}`,
            `imagePrompt: ${truncateText(item.prompt || "", 260)}`,
          ].join("\n");
        })
        .join("\n\n");
      const safeHistory = history
        .slice(-8)
        .map((item) => `${item.role === "user" ? "用户" : "助手"}：${truncateText(item.content, 500)}`)
        .join("\n");

      const system = [
        "你是 Toonflow 分镜台内的视频提示词修改 Agent。",
        "任务：根据用户对话要求，修改当前视频轨道的生成提示词，并返回可直接用于图生视频/文生视频模型的最终 prompt。",
        "硬规则：",
        "1. 只修改当前轨道，不改分镜、不改资产、不扩写无关剧情。",
        "2. 必须保留分镜中的关键剧情、动作、角色、道具、场景和所有中文台词；中文台词必须普通话配音，不要字幕。",
        "3. 已有中文台词、内心OS、画外音、旁白或系统播报必须原样保留；无台词/低台词片段按当前剧情补充中文普通话对白、内心OS或画外音到约每秒2-3个中文字符；不得新增角色、道具、场景或剧情结果；不要字幕。",
        "4. 每个最终 prompt 必须包含 BGM/背景音乐/Background music 描述；根据剧情情节、情绪、动作强度和台词语气写清配乐气质、节奏、音量和起伏；BGM 必须无歌词、低于中文对白和关键音效。",
        "5. 如用户要求与分镜事实冲突，优先遵守分镜事实，并在 reply 中说明取舍。",
        "6. 如果是 Grok 视频模型，画面描述尽量用英文，但所有 spoken dialogue / voiceover / narration / OS / VO / dubbing 必须是中文普通话；禁止把台词翻译成英文，不要写字幕、caption、onscreen text。",
        "7. 最终 prompt 不要输出分析过程、Markdown 或 JSON 以外的内容。",
        "8. 输出 JSON：{\"reply\":\"给用户看的简短说明\",\"prompt\":\"完整新视频提示词\"}。",
      ].join("\n");

      const prompt = [
        `项目：${project?.name || projectId}`,
        `视频模型：${model || project?.videoModel || ""}`,
        `轨道ID：${trackId}`,
        `轨道时长：${track.duration || ""}s`,
        "",
        "当前视频提示词：",
        compactPrompt(currentPrompt || track.prompt || ""),
        "",
        "当前轨道分镜：",
        storyboardLines || "无分镜上下文",
        "",
        "关联资产：",
        assetLines || "无资产上下文",
        "",
        "最近对话：",
        safeHistory || "无",
        "",
        "用户本轮要求：",
        message,
      ].join("\n");

      const ai = u.Ai.Text("productionAgent", false, 0);
      const result = await ai.invoke({
        system,
        prompt,
      });
      const parsed = parseJsonObject(result.text);
      const modelName = normalizeText(model || project?.videoModel || "");
      const requiredDialogueLines = uniqueText(storyboards.map((item: any) => extractDialogueFromVideoDesc(item.videoDesc)).filter(Boolean));
      const nextPrompt = ensureMandarinDialogueLanguageRule(
        ensureBgmCue(String(parsed.prompt || ""), storyboards, /grok|imagine/i.test(modelName)),
        requiredDialogueLines,
      );
      if (!nextPrompt) throw new Error("Agent 未返回有效视频提示词");
      const reply = normalizeText(parsed.reply) || "已根据要求修改视频提示词。";

      await u.db("o_videoTrack").where({ id: trackId }).update({
        prompt: nextPrompt,
      });

      res.status(200).send(success({ reply, prompt: nextPrompt }));
    } catch (e) {
      res.status(400).send(error(u.error(e).message));
    }
  },
);
