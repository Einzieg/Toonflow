# CPA Grok Imagine Video 1.5 Preview 接入文档

更新时间：2026-06-15

本文档用于把 CPA（CLIProxyAPI）的 `grok-imagine-video-1.5-preview` 视频模型接入到 Toonflow 以外的其它项目。

## 1. 接入结论

- 供应商：CPA / CLIProxyAPI
- 模型 ID：`grok-imagine-video-1.5-preview`
- 能力：图生视频，当前 Toonflow 已验证路径为单图生视频
- 音频：不支持，业务侧应固定 `audio=false`
- 时长：支持 `6` 秒、`10` 秒或 `15` 秒
- 分辨率：当前稳定配置暴露 `720p`，请求 CPA 时映射为 `1280x720`
- 轮询超时：建议至少 `30` 分钟
- 视频结果：优先读取任务状态返回中的 `video.url`，不要优先依赖 `/videos/{id}/content`

## 2. 服务地址

CPA 默认 OpenAI-compatible 地址以 `/v1` 结尾：

```text
http://cli-proxy-api:8317/v1
```

不同部署方式的推荐配置：

- 同一 Docker 网络内：使用 `http://cli-proxy-api:8317/v1`
- 宿主机进程访问：使用 `http://127.0.0.1:8317/v1`
- 其它容器访问：确保该容器与 `cli-proxy-api` 在同一 Docker network，或配置可访问的网关地址

如果出现 `getaddrinfo ENOTFOUND cli-proxy-api`，原因通常是调用方容器不在 `cli-proxy-api` 所在网络内，或服务名不是 `cli-proxy-api`。

## 3. 模型元数据

接入方如果有模型注册表，可按下面配置：

```ts
{
  name: "Grok Imagine Video 1.5 Preview",
  modelName: "grok-imagine-video-1.5-preview",
  type: "video",
  mode: ["singleImage"],
  audio: false,
  durationResolutionMap: [
    { duration: [6, 10, 15], resolution: ["720p"] }
  ],
}
```

时长归一化规则：

```ts
function toVideoSeconds(duration?: number) {
  const value = Number(duration || 6);
  if (value <= 6) return 6;
  if (value <= 10) return 10;
  return 15;
}
```

分辨率映射规则：

```ts
function toVideoSize(resolution?: string) {
  const value = String(resolution || "720p").toLowerCase();
  if (value === "480p") return "848x480";
  if (value === "960p") return "1696x960";
  if (value === "1080p") return "1920x1080";
  return "1280x720";
}
```

注意：不要向 CPA 传 `720x1280`。当前已遇到过 `unknown variant 720x1280` 报错，CPA 期望的是 `848x480`、`1280x720`、`1696x960`、`1920x1080` 这类枚举值。

## 4. 创建视频任务

接口：

```text
POST {baseUrl}/videos
```

Headers：

```http
Authorization: Bearer <CPA_API_KEY>
Content-Type: application/json
```

最小请求体：

```json
{
  "model": "grok-imagine-video-1.5-preview",
  "prompt": "按参考图生成一个 15 秒短视频，保持角色、服装、场景和画风一致。镜头自然推进，无字幕。",
  "seconds": 15,
  "size": "1280x720",
  "input_reference": {
    "image_url": "https://example.com/reference.jpg"
  }
}
```

`image_url` 推荐使用公网可访问的 HTTP/HTTPS 图片 URL。不要默认把大图转成 base64 放进请求体，否则容易触发 413 或导致请求体过大。

## 5. 轮询任务

创建任务后，响应里通常会返回 `id` 或 `request_id`。接入方需要轮询：

```text
GET {baseUrl}/videos/{taskId}
```

推荐轮询策略：

- 间隔：`5s`
- 总超时：`30min`
- 成功状态：`completed`、`succeeded`、`success`、`done`
- 失败状态：`failed`、`error`、`cancelled`、`canceled`

成功响应中优先解析这些字段：

```ts
const candidates = [
  data?.video?.url,
  data?.video_url,
  data?.url,
  data?.data?.video?.url,
  data?.data?.video_url,
  data?.data?.url,
  data?.output?.video?.url,
  data?.output?.video_url,
  data?.output?.url,
  data?.result?.video?.url,
  data?.result?.video_url,
  data?.result?.url,
];
```

只要拿到 HTTP/HTTPS URL，就应直接作为视频结果返回或保存。

## 6. 不要优先调用 content 下载接口

CPA 可能在任务状态已经 `done` 且 `video.url` 有效时，让下面接口返回 `404`：

```text
GET {baseUrl}/videos/{taskId}/content
```

正确策略：

1. 先读取状态接口里的 `video.url`
2. 如果状态接口没有视频 URL，再兜底尝试 `/content`
3. 如果业务支持远程播放，优先直接保存远程 URL，后台异步本地化即可

## 7. 提示词限制

CPA/Grok 对提示词长度敏感，按 UTF-8 字节计算比按 JS 字符数更可靠。

推荐策略：

- 上限按 `3000 bytes` 主动压缩，给上游保留余量
- 不要把参考图 URL、资产长描述、完整剧本全文全部塞进 prompt
- 中文提示词要按字节限制，不要按 `string.length`

示例：

```ts
const MAX_VIDEO_PROMPT_BYTES = 3000;

function getUtf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}
```

## 8. 多图能力说明

当前 Toonflow 对 `grok-imagine-video-1.5-preview` 的稳定接入是单图生视频：

```json
{
  "input_reference": {
    "image_url": "https://example.com/reference.jpg"
  }
}
```

CPA 的旧 `grok-imagine-video` 已按多图参考路径做过适配，字段形态是：

```json
{
  "reference_images": [
    { "url": "https://example.com/ref-1.jpg" },
    { "url": "https://example.com/ref-2.jpg" }
  ]
}
```

如果其它项目要把 `grok-imagine-video-1.5-preview` 也开放为多图，需要先单独验通 CPA 对该模型的 `reference_images` 支持，再把模型能力从 `["singleImage"]` 扩展为 `["singleImage", ["imageReference:7"]]`。不要在未验证前直接默认 1.5 支持多图生产路径。

## 9. Toonflow 当前实现参考

关键文件：

- `data/vendor/cliproxyapi.ts`：CPA 供应商定义、模型注册、任务创建、轮询、结果解析
- `src/utils/storyboardTrack.ts`：Grok 1.5 Preview 视频时长支持 `6`、`10`、`15`
- `src/utils/videoSource.ts`：生成可被 CPA 拉取的公网 OSS 图片 URL
- `src/routes/production/storyboardBoard/generateVideo.ts`：故事板单图生成视频入口
- `src/routes/production/workbench/generateVideo.ts`：视频工作台生成视频入口

Toonflow 内部对 CPA 的关键处理：

- 图片参考优先传公网 URL，不传大 base64
- `grok-imagine-video-1.5-preview` 必须带一张参考图
- 任务创建后保存 `externalTaskId`
- 轮询成功后优先使用 `video.url`
- 远程 URL 可立即返回前端，本地保存可异步执行

## 10. 常见错误

| 错误 | 原因 | 处理 |
| --- | --- | --- |
| `getaddrinfo ENOTFOUND cli-proxy-api` | 调用方无法解析 CPA 容器名 | 加入同一 Docker 网络，或改用宿主机可访问地址 |
| `unknown variant 720x1280` | `size` 传了 CPA 不支持的枚举 | 使用 `1280x720`，不要传竖屏尺寸字符串 |
| `Prompt length exceeds...` | 提示词按字节超限 | 按 UTF-8 bytes 压缩到 3000 bytes 左右 |
| `Request failed with status code 413` | 请求体过大，常见于 base64 图片 | 改传公网图片 URL |
| `/content` 返回 404 | CPA 状态接口已有 `video.url`，但 content 接口不可用 | 优先使用 `video.url` |
| `Video ... not found` | taskId 错误、查错 baseUrl、或任务还未同步 | 核对 `baseUrl`、`taskId`，增加轮询重试 |
| TLS/socket 临时断开 | 网络抖动，任务未必失败 | 不要立即标记失败，先按 taskId 继续查状态 |

## 11. 最小 curl 验证

```bash
export CPA_BASE="http://127.0.0.1:8317/v1"
export CPA_KEY="your-api-key"
export IMAGE_URL="https://example.com/reference.jpg"

curl -sS "$CPA_BASE/videos" \
  -H "Authorization: Bearer $CPA_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"grok-imagine-video-1.5-preview\",
    \"prompt\": \"Generate a 15-second cinematic video from the reference image. Keep the same character identity, outfit, scene, lighting, and visual style. Natural motion, no subtitles.\",
    \"seconds\": 15,
    \"size\": \"1280x720\",
    \"input_reference\": {
      \"image_url\": \"$IMAGE_URL\"
    }
  }"
```

查询任务：

```bash
curl -sS "$CPA_BASE/videos/<task-id>" \
  -H "Authorization: Bearer $CPA_KEY"
```

验收标准：

- 创建接口返回 `id` 或 `request_id`
- 查询接口最终返回 `done` / `completed` 等成功状态
- 查询响应里存在 `video.url` 或等价 URL 字段
- 前端可直接播放该 URL
