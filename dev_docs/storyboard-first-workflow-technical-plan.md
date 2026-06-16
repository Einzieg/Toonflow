# 故事板先行工作流改造技术方案

## 1. 背景与目标

当前“故事板辅助单图模式”嵌在分镜图节点 `storyboard.vue` 内，后端 `storyboardBoard/create` 依赖已有 `o_storyboard` 数据和 `storyboardIds`。这意味着它只能作为“分镜图生成之后的辅助功能”，不符合“故事板先行”的工作方式。

本次改造目标是新增一条与当前分镜图工作流并列的独立分支：

```text
剧本
├─ 当前主流程：分镜规划 -> 分镜表 -> 分镜图 -> 视频工作台
└─ 新流程：分镜脚本 -> 故事板图片 -> 故事板转视频
```

新流程的三个阶段：

1. 剧本 -> 分镜脚本
2. 生成故事板图片
3. 故事板转视频

关键原则：

- 故事板先行工作流不能依赖 `o_storyboard` 的分镜图记录。
- 故事板先行产物不能写入当前视频工作台 `workbench.videoList`，避免污染原分镜图视频生产链路。
- 可共享项目剧本、项目画风、导演手册、资产中心、图片模型、视频模型。
- 故事板图片固定 `9:16` 竖版，沿用现有竖版约束。
- 故事板图片不是把分镜图拼成长图；它由 Agent 先生成分镜脚本，再按镜头脚本生成一张包含多格镜头卡片的竖版故事板图。

## 2. 当前实现边界

现有相关前端：

- `Toonflow-web/src/views/production/node/storyboard.vue`
- `Toonflow-web/src/views/production/node/storyboardBoardPanel.vue`
- `Toonflow-web/src/views/production/utils/flowBuilder.ts`
- `Toonflow-web/src/views/production/index.vue`

现有相关后端：

- `src/routes/production/storyboardBoard/create.ts`
- `src/routes/production/storyboardBoard/list.ts`
- `src/routes/production/storyboardBoard/regenerate.ts`
- `src/routes/production/storyboardBoard/generateVideo.ts`
- `src/routes/production/storyboardBoard/delete.ts`
- `src/utils/storyboardBoard.ts`

现有数据表：

- `o_storyboardBoard`
- `o_storyboardBoardVideo`

现有限制：

- `create.ts` 入参必须包含 `storyboardIds`。
- 分镜脚本由已存在分镜文本和分镜图辅助生成。
- 故事板面板在 UI 上属于分镜图节点内部组件，不是独立工作流节点。

## 3. 目标架构

新增独立节点：

```text
script -> storyboardFirstScript -> storyboardFirstImage -> storyboardFirstVideo
```

推荐节点命名：

- `storyboardFirstScript`：分镜脚本节点
- `storyboardFirstImage`：故事板图片节点
- `storyboardFirstVideo`：故事板视频节点

新节点不替换现有主流程，默认并列显示。

布局建议：

```text
script        scriptPlan       storyboardTable       storyboard        workbench
  |
  v
assets
  |
  v
storyboardFirstScript -> storyboardFirstImage -> storyboardFirstVideo
```

自动布局时，新分支放在 `assets` 下方第二行，作为独立泳道，避免和当前 `assets` 节点重叠。

## 3.1 实施前必须遵守的硬性约束

以下约束属于实施前置条件，不满足时不要进入编码阶段：

- 新流程不能直接调用 `generateStoryboardBoardImageFromScript(storyboards, context)`，因为该函数会读取 `o_storyboard`、分镜图路径和分镜资产关系，违反“故事板先行不依赖分镜面板”的边界。
- `src/utils/storyboardBoard.ts` 只能抽出通用能力，例如提示词压缩、缩略图生成、视频模型校验、远程视频保存状态同步；故事板先行必须新增 `src/utils/storyboardFirst.ts`，输入不能包含 `StoryboardBoardInput[]`。
- 所有异步生成任务必须带 `jobToken` 或 `generationId`。后台任务完成写回数据库时必须带 token 条件，防止删除、重生成或重复点击后旧任务覆盖新结果。
- 所有缓存和失效判断必须基于明确哈希：`inputHash`、`shotScriptHash`、`imageSourceHash`。不能只依赖 `projectId/scriptId` 或旧 `sourceHash`。
- 修改分镜脚本后，下游图片和视频必须变成 `stale=true` 或被标记为非当前版本；前端必须禁用“故事板转视频”，直到重新生成故事板图片。
- 故事板图片固定 `9:16`。故事板转视频的 `aspectRatio` 也必须显式保存和校验，默认使用 `9:16`，不能隐式跟随项目 `videoRatio`。
- 新路由文件添加后不能手写维护 `src/router.ts`。当前路由文件由 `src/core.ts` 扫描 `src/routes/**/*.ts` 自动生成，实施时必须触发路由生成并验证 `router.ts` hash 更新。
- 项目删除、剧集删除、清空故事板先行工作流、图片重生成、单项删除都必须复用同一套清理函数，避免 OSS 文件、`o_video` 和新三表留下孤儿数据。
- 前端三个新节点不能各自轮询接口。必须抽共享 composable 或 store，例如 `useStoryboardFirstWorkflow(projectId, scriptId)`，集中负责加载、轮询、状态更新和 action。
- Agent 必须把“故事板先行”作为独立路由，不允许落入现有阶段5/6分镜面板工具。
- 路由层只做入参校验和返回包装；生成脚本、生成图片、重生成图片、生成视频、清理数据必须落在 `src/utils/storyboardFirst.ts` 和 `src/utils/storyboardFirstCleanup.ts` 的 service 函数中，避免前端接口和 Agent 工具各复制一套逻辑。

## 4. 数据模型

建议新增独立表，不复用 `o_storyboardBoard`。原因是现有表字段中 `storyboardIds/startIndex/endIndex/itemsPerBoard` 都隐含依赖 `o_storyboard`。

### 4.1 `o_storyboardFirstScript`

用途：保存“剧本 -> 分镜脚本”的阶段产物。

字段建议：

```ts
{
  id: number;
  projectId: number;
  scriptId: number;
  inputHash: string;
  shotScriptHash: string;
  scriptRevision: number;
  promptVersion: string;
  jobToken: string;
  scriptContentSnapshot: string;
  projectName: string;
  projectType: string;
  artStyle: string;
  directorManual: string;
  targetDuration: number;
  segmentCount: number;
  shotScript: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败" | "已取消";
  errorReason: string;
  createTime: number;
  updateTime: number;
}
```

说明：

- `inputHash` 用于避免重复生成同一份分镜脚本。
- `shotScriptHash` 用于下游图片和视频判断是否过期。
- `scriptRevision` 每次用户手动编辑或重新生成脚本时递增。
- `promptVersion` 固定写入当前提示词版本，提示词升级后可以主动失效旧结果。
- `jobToken` 用于异步任务写回校验。
- `scriptContentSnapshot` 用于后续追溯，避免剧本修改后旧结果来源不清。
- `targetDuration` 是整段或单次生成目标时长，不等同于单镜头时长。

### 4.2 `o_storyboardFirstImage`

用途：保存故事板图片。

字段建议：

```ts
{
  id: number;
  projectId: number;
  scriptId: number;
  firstScriptId: number;
  scriptRevision: number;
  shotScriptHash: string;
  shotScriptSnapshot: string;
  filePath: string;
  thumbPath: string;
  imagePrompt: string;
  imageModel: string;
  imageQuality: string;
  ratio: "9:16";
  imageSourceHash: string;
  assetHash: string;
  referenceSnapshot: string;
  version: number;
  isCurrent: number;
  invalidatedAt: number;
  jobToken: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败" | "已取消";
  errorReason: string;
  createTime: number;
  updateTime: number;
}
```

说明：

- 图片只依赖 `firstScriptId` 和项目上下文。
- `imageSourceHash` 必须包含 `shotScriptHash`、`scriptRevision`、项目画风、导演手册、图片模型、图片质量、资产引用快照或资产哈希。
- 重生成图片时推荐创建新版本，成功后把旧版本 `isCurrent=0` 并清理旧图关联视频；生成失败时保留旧版本继续可预览。
- 如果旧图对应的 `shotScriptHash` 已经落后于当前脚本，`list` 接口应返回 `stale=true`；如果只是同一脚本下重生成失败，旧图不应被标记为 stale。
- `invalidatedAt` 只用于审计或辅助排查，不作为 stale 的真相来源。
- 缩略图继续保存到 `thumbPath`，前端列表默认使用缩略图。

### 4.3 `o_storyboardFirstVideo`

用途：保存故事板转视频任务。

字段建议：

```ts
{
  id: number;
  projectId: number;
  scriptId: number;
  firstScriptId: number;
  firstImageId: number;
  videoId: number;
  imageSourceHash: string;
  firstImageVersion: number;
  model: string;
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: "9:16";
  audio: number;
  jobToken: string;
  state: "生成中" | "已完成" | "生成失败" | "已取消";
  errorReason: string;
  createTime: number;
  updateTime: number;
}
```

说明：

- 具体视频文件/远程链接仍复用 `o_video`。
- `videoTrackId` 必须为 `null`，表示不属于主视频工作台轨道。
- 删除 `o_video` 时必须同时校验 `projectId/scriptId/videoTrackId IS NULL/videoId 属于 o_storyboardFirstVideo`，避免误删主工作台视频。
- `imageSourceHash` 和 `firstImageVersion` 用于确认视频来自哪一版故事板图片。
- 前端预览和下载使用 `getRenderableVideoSrc`。
- `resolution` 必须保存“模型适配后的请求分辨率”，不能由前端直接把 `9:16` 翻译成固定字符串。供应商只支持枚举尺寸时，后端必须通过模型适配层选择合法值，不能再次传出未支持的 `720x1280`。

### 4.4 索引与唯一约束

推荐索引：

```ts
o_storyboardFirstScript:
- index(projectId, scriptId)
- index(projectId, scriptId, inputHash)
- index(state)

o_storyboardFirstImage:
- index(projectId, scriptId)
- index(firstScriptId)
- index(firstScriptId, isCurrent)
- index(imageSourceHash)
- index(state)

o_storyboardFirstVideo:
- index(projectId, scriptId)
- index(firstImageId)
- index(videoId)
- index(state)
```

唯一约束建议谨慎使用。SQLite 对部分唯一索引支持有限，MVP 可用事务和 `生成中` 查询控制幂等；后续可增加 `unique(firstScriptId, imageSourceHash, version)`。

应用层幂等必须使用事务：

```ts
await u.db.transaction(async (trx) => {
  const running = await trx(table).where({ ownerId, state: "生成中" }).first();
  if (running) return running;
  await trx(table).insert(newRunningRow);
});
```

要求：

- “查询运行中任务”和“插入/更新生成中任务”必须在同一事务内完成。
- 后台异步写回不在该事务内，但必须使用 `jobToken` 条件更新。
- 双击生成、接口重试、页面轮询重复触发都必须复用同一个运行中任务。

### 4.5 版本、失效与当前版本规则

- `o_storyboardFirstScript` 是脚本源头。脚本重生成或手动编辑后，必须更新 `shotScriptHash` 并递增 `scriptRevision`。
- `stale` 不作为数据库真相字段。`list` 接口必须基于 hash 动态计算 stale，避免字段和真实依赖不一致。
- `o_storyboardFirstImage.shotScriptHash !== o_storyboardFirstScript.shotScriptHash` 时，图片返回 `stale=true`。
- `o_storyboardFirstVideo.imageSourceHash !== o_storyboardFirstImage.imageSourceHash` 时，视频返回 `stale=true`。
- 前端只把 `isCurrent=1` 的图片作为当前故事板图。
- 旧图片版本可以保留用于审计，但默认不展示；如果要简化 MVP，可以只保留当前版本，但必须在新图生成成功后再删除旧文件。
- 过期图片可以预览和下载，但不能作为新视频生成输入。

### 4.6 并发与异步写回规则

所有异步接口遵守同一规则：

```ts
const jobToken = uuid();
await db(table).where({ id }).update({ state: "生成中", jobToken });

// 后台任务完成后：
await db(table)
  .where({ id, jobToken, state: "生成中" })
  .update({ state: "已完成", ...result });
```

规则说明：

- 删除或重生成时必须让旧 `jobToken` 失效。
- 后台任务完成后，如果 token 不匹配，不能写回当前记录；只允许尝试清理刚生成但已失效的临时文件。
- 双击生成按钮只能产生一条 `生成中` 记录。
- 删除接口遇到 `生成中` 记录时，必须先将其标记为 `已取消` 并更新 token，再执行清理。

## 5. 后端接口设计

建议新增目录：

```text
src/routes/production/storyboardFirst/
```

### 5.1 `list.ts`

路径：

```text
POST /api/production/storyboardFirst/list
```

入参：

```ts
{
  projectId: number;
  scriptId: number;
}
```

返回固定为聚合结构，不同时支持多种形态：

```ts
{
  script: {
    id: number;
    shotScript: string;
    scriptRevision: number;
    shotScriptHash: string;
    state: string;
    errorReason: string;
  } | null;
  image: {
    id: number;
    imageUrl: string;
    thumbUrl: string;
    version: number;
    imageSourceHash: string;
    stale: boolean;
    state: string;
    errorReason: string;
  } | null;
  latestVideo: {
    id: number;
    videoId: number;
    src: string;
    imageSourceHash: string;
    stale: boolean;
    state: string;
    errorReason: string;
  } | null;
  videoHistory: Array<{
    id: number;
    videoId: number;
    src: string;
    duration: number;
    resolution: string;
    aspectRatio: "9:16";
    state: string;
    errorReason: string;
  }>;
}
```

### 5.2 `generateScript.ts`

路径：

```text
POST /api/production/storyboardFirst/generateScript
```

入参：

```ts
{
  projectId: number;
  scriptId: number;
  targetDuration?: number;
  force?: boolean;
}
```

行为：

- 读取 `o_script.content`。
- 读取 `o_project` 的 `name/type/artStyle/directorManual/imageModel/videoRatio`。
- 可读取项目资产，用资产描述辅助角色和场景一致性。
- 生成“分镜脚本”，不是 `o_storyboard` 分镜表。
- `inputHash` 必须包含剧本文本、目标时长、项目画风、导演手册、资产摘要、模型和提示词版本。
- 如果存在相同 `inputHash` 且 `force !== true`，返回已有完成记录。
- 若存在 `生成中` 记录，返回已有任务，不重复发起。
- 新任务必须写入 `jobToken`，后台完成时按 token 写回。

输出脚本结构建议：

```md
# 故事板先行分镜脚本
总时长：xxs

## 镜头 01 / 3s
- 画面内容：
- 景别：
- 运镜：
- 构图：
- 角色调度：
- 台词/字幕：
- 声音/情绪：
- 故事板画面：

## 镜头 02 / 4s
...
```

约束：

- 单镜头时长不超过 5 秒。
- 10 秒视频至少 3-5 个镜头。
- 6 秒目标时长建议 2-3 个镜头，10 秒目标时长建议 3-5 个镜头，15 秒目标时长建议 4-6 个镜头；镜头数量由 Agent 根据剧情节奏自动判断，但不能少于满足“单镜头不超过 5 秒”的最低数量。
- `segmentCount` 必须写入数据库，图片生成时以该值和脚本实际镜头数校验故事板格数，不能把整部剧本或所有分镜图一次性塞进一张故事板图。
- 动作幅度较大的镜头建议单独成一个镜头段，避免生成结果过于模糊。
- 台词默认中文。
- 不允许假设已有分镜图。

### 5.3 `updateScript.ts`

路径：

```text
POST /api/production/storyboardFirst/updateScript
```

入参：

```ts
{
  firstScriptId: number;
  shotScript: string;
}
```

用途：

- 支持用户手动修正分镜脚本。
- 更新时递增 `scriptRevision`，重新计算 `shotScriptHash`。
- 更新后无需写入 stale 字段；`list` 接口通过 hash 比较返回当前图片和视频的 `stale=true`，前端提示“脚本已更新，需要重新生成故事板图片”。
- 过期图片仍可预览和下载，但不能继续发起新的视频生成。

### 5.4 `generateImage.ts`

路径：

```text
POST /api/production/storyboardFirst/generateImage
```

入参：

```ts
{
  firstScriptId: number;
  force?: boolean;
}
```

行为：

- 根据 `firstScriptId.shotScript` 生成竖版故事板图片。
- 可引用资产图作为参考，不引用 `o_storyboard` 分镜图。
- 参考图必须使用资产原图或经过尺寸校验的临时放大图，不能使用缩略图作为上游参考图。若原图短边小于供应商要求，应在后端放大到合法尺寸或跳过该参考图并写入 `referenceSnapshot`。
- 如果已有图片且 `force !== true`，返回已有图片。
- 如果 `force === true`，创建新版本图片任务。新图生成成功后，旧版本置为 `isCurrent=0` 并清理旧版本关联视频；新图生成失败时保留旧版本。
- 同一 `firstScriptId` 同一 `imageSourceHash` 已有 `生成中` 任务时，直接返回该任务。

复用逻辑：

- 可从 `src/utils/storyboardBoard.ts` 抽出通用函数：
  - `buildStoryboardBoardImagePrompt`
  - 参考图压缩与缩略图生成逻辑

需要改造点：

- 当前 `generateStoryboardBoardImageFromScript(storyboards, context)` 以 `storyboards` 为输入。应新增更通用函数：

```ts
generateStoryboardFirstImageFromScript(shotScript: string, context: StoryboardFirstContext)
```

该函数禁止读取 `o_storyboard`，只能读取项目、剧本快照、导演手册和 `o_assets`。

### 5.5 `regenerateImage.ts`

路径：

```text
POST /api/production/storyboardFirst/regenerateImage
```

入参：

```ts
{
  firstImageId: number;
}
```

行为：

- 这是 UI 便捷接口，内部必须复用 `generateImage(firstScriptId, force=true)` 的同一套 service，不允许复制第二套删除和生成逻辑。
- 通过 `firstImageId` 找到 `firstScriptId` 后创建新版本图片。
- 新图成功后再清理旧图片、缩略图、该图片下的视频记录和未挂轨道的 `o_video`。
- 生成失败时保留旧图片。旧图片是否 stale 由 `list` 接口根据 `shotScriptHash` 动态计算。

### 5.6 `generateVideo.ts`

路径：

```text
POST /api/production/storyboardFirst/generateVideo
```

入参：

```ts
{
  firstImageId: number;
  model: string;
  duration: number;
  resolution: string;
  audio?: boolean;
}
```

行为：

- 校验模型支持 `singleImage`。
- 图片引用使用故事板图片。
- 提示词由 `shotScript + 视频模型能力 + 时长限制` 生成。
- 生成后写入 `o_video` 和 `o_storyboardFirstVideo`。
- 不写入主工作台轨道。
- 如果 `firstImageId` 对应图片动态计算结果为 `stale=true`，拒绝生成并提示先重新生成故事板图片。
- `aspectRatio` 默认固定为 `9:16`，写入 `o_storyboardFirstVideo.aspectRatio`，调用视频模型时也传 `9:16`。
- `duration` 必须来自模型能力配置，不允许前端硬编码。Grok 当前可展示 `6/10/15` 秒；Seedance 和其他模型按供应商配置展示。
- `resolution` 必须由 `getVideoModelDetail` 或供应商适配函数转换成合法枚举。若模型不支持竖版或单图模式，后端直接拒绝，不尝试传非法尺寸。
- 视频生成任务必须写入 `jobToken`，后台写回 `o_video` 和 `o_storyboardFirstVideo` 时都要校验当前任务仍有效。

复用逻辑：

- `getRenderableVideoSrc`
- `REMOTE_VIDEO_URL_TTL_MS`
- `resolveVideoGenerationDuration`
- `resolveVideoGenerationResolution` 或等价模型适配函数
- `buildStoryboardBoardVideoPrompt` 可抽为更通用的：

```ts
buildStoryboardFirstVideoPrompt(shotScript: string, model: string, duration: number)
```

### 5.7 `delete.ts`

路径：

```text
POST /api/production/storyboardFirst/delete
```

入参：

```ts
{
  firstScriptId?: number;
  firstImageId?: number;
}
```

行为：

- `firstScriptId` 和 `firstImageId` 必须且只能传一个。
- 删除脚本时级联删除图片、视频、`o_video` 记录和 OSS 文件。
- 删除图片时保留分镜脚本，但删除图片和视频。
- 删除前必须使相关 `jobToken` 失效，防止后台任务删除后写回。

### 5.8 `clear.ts`

路径：

```text
POST /api/production/storyboardFirst/clear
```

入参：

```ts
{
  projectId: number;
  scriptId: number;
  confirm: true;
}
```

行为：

- 清空当前项目当前剧集下所有故事板先行脚本、图片、视频、关联 `o_video` 和 OSS 文件。
- 必须要求 `confirm === true`，防止误触发。
- 清理前先使本剧集下所有 `jobToken` 失效。
- 该接口用于前端“清空故事板先行工作流”和 Agent `clear_storyboard_first_workflow`，不能复用旧分镜面板清空接口。
- 清空范围只限 `o_storyboardFirstScript/Image/Video` 和这些记录关联的 `videoTrackId IS NULL` 视频，不能删除 `o_storyboard`、`o_storyboardBoard` 或主视频工作台数据。

## 6. 前端改造方案

### 6.1 flowBuilder 新增节点

修改：

```text
Toonflow-web/src/views/production/utils/flowBuilder.ts
```

新增 `NODE_IDS`：

```ts
storyboardFirstScript: "storyboardFirstScript",
storyboardFirstImage: "storyboardFirstImage",
storyboardFirstVideo: "storyboardFirstVideo",
```

新增节点：

```ts
{
  id: ids.storyboardFirstScript,
  type: "storyboardFirstScript",
  position: positions[ids.storyboardFirstScript] || { x: 0, y: 900 },
  data: { handleIds: { target: "...", source: "..." } },
}
```

新增边：

```text
script -> storyboardFirstScript
storyboardFirstScript -> storyboardFirstImage
storyboardFirstImage -> storyboardFirstVideo
```

注意：

- `script` 节点已有 `source` 和 `assets` handle。必须给故事板先行新增独立 source handle，例如 `storyboardFirst`，避免边重叠。
- 禁止复用 `script-source`，否则新分支会和主流程边线重叠，用户无法区分两条工作流。
- `assets` 和 `storyboardFirst` 两个 bottom handle 需要左右偏移，例如 `assets` 位于 35%，`storyboardFirst` 位于 65%。

### 6.1.1 布局要求

当前 `production/index.vue` 的手动 LR 布局会把 `assets` 放在 `script` 正下方，因此故事板先行不能简单使用 `{ x: 0, y: 900 }`。

必须新增独立泳道：

```ts
const mainChain = ["script", "scriptPlan", "storyboardTable", "storyboard", "workbench"];
const storyboardFirstChain = ["storyboardFirstScript", "storyboardFirstImage", "storyboardFirstVideo"];
```

布局规则：

- 主流程保持横向。
- `assets` 放在 `script` 下方第一行。
- `storyboardFirstChain` 放在 `assets` 下方第二行，横向排列。
- `layoutGraph("LR")` 必须显式处理 `storyboardFirstChain`，不能只依赖 dagre fallback。
- `nodePositions` 默认值必须包含三个新节点，避免首次加载时节点重叠。

### 6.2 新增节点组件

建议新增：

```text
Toonflow-web/src/views/production/node/storyboardFirstScript.vue
Toonflow-web/src/views/production/node/storyboardFirstImage.vue
Toonflow-web/src/views/production/node/storyboardFirstVideo.vue
```

职责划分：

- `storyboardFirstScript.vue`
  - 展示分镜脚本。
  - 按钮：生成分镜脚本、编辑脚本、重新生成。
  - 状态：未生成、生成中、已完成、生成失败。

- `storyboardFirstImage.vue`
  - 展示故事板图片缩略图。
  - 按钮：生成故事板图片、重生成图片、预览原图、下载图片。
  - 固定展示 `9:16 竖版`。

- `storyboardFirstVideo.vue`
  - 选择单图视频模型、时长、分辨率、音频开关。
  - 按钮：故事板转视频、预览视频、下载视频。
  - 生成前保留确认弹窗。

### 6.3 production/index.vue 注册节点

修改：

```text
Toonflow-web/src/views/production/index.vue
```

新增 import：

```ts
import storyboardFirstScript from "./node/storyboardFirstScript.vue";
import storyboardFirstImage from "./node/storyboardFirstImage.vue";
import storyboardFirstVideo from "./node/storyboardFirstVideo.vue";
```

新增模板 slot：

```vue
<template #node-storyboardFirstScript="props">
  <storyboardFirstScript
    :id="props.id"
    :project-id="Number(project?.id) || undefined"
    :script-id="episodesId"
    :handleIds="props.data.handleIds" />
</template>
```

`storyboardFirstImage` 和 `storyboardFirstVideo` 同理。

`storyboardFirstVideo` 还需要传入 `projectVideoModel`，用于默认选中项目视频模型：

```vue
<storyboardFirstVideo
  :project-id="Number(project?.id) || undefined"
  :script-id="episodesId"
  :project-video-model="project?.videoModel"
  :handleIds="props.data.handleIds" />
```

### 6.4 状态管理

现有生产流数据保存在 `productionAgent` 记忆和 `flowData` 中，但故事板先行产物不要塞入 `flowData`，否则会扩大现有保存/读取结构。

必须新增共享 composable：

```text
Toonflow-web/src/views/production/composables/useStoryboardFirstWorkflow.ts
```

职责：

- 统一维护 `script/image/latestVideo/videoHistory`。
- 统一封装 `load/generateScript/updateScript/generateImage/regenerateImage/generateVideo/deleteWorkflow`。
- 统一管理轮询，三个节点共享同一份状态。
- 轮询必须有 in-flight guard，避免重复请求。
- 所有状态都进入终态后停止轮询。
- 组件卸载或切换剧集时停止旧轮询并清空旧状态。
- watch `[projectId, scriptId]`，切换剧集时先清空 UI，再重新加载。

伪代码：

```ts
let polling = false;
let loading = false;

async function load() {
  if (loading) return;
  loading = true;
  try {
    state.value = await api.list(projectId.value, scriptId.value);
  } finally {
    loading = false;
  }
}

function shouldPoll() {
  return [state.value.script?.state, state.value.image?.state, state.value.latestVideo?.state].includes("生成中");
}
```

### 6.5 stale 状态展示

前端必须展示下游过期状态：

- 脚本更新后，图片节点显示“脚本已更新，故事板图片需重新生成”。
- 图片过期时，视频节点禁用“故事板转视频”按钮。
- 视频过期时，视频节点显示“该视频基于旧故事板图片生成”。
- `list` 接口返回的 `stale` 必须直接驱动 UI，不允许前端自行猜测。

### 6.6 旧故事板辅助面板边界

短期策略固定为：

- 保留 `storyboard.vue` 内的旧 `storyboardBoardPanel.vue`，但 UI 文案改名为“分镜图辅助故事板”。
- 不删除旧入口，避免影响已使用旧模式的项目。
- 新故事板先行节点不能 import `storyboardBoardPanel.vue`，不能复用它的 DTO。
- 只能抽出无业务耦合的小组件或 composable，例如模型选择、图片预览、视频预览、下载按钮。

## 7. Agent 改造方案

新增 agent 能力，不要复用“写入分镜面板”的工具。

建议新增工具：

```ts
get_storyboard_first_state
generate_storyboard_first_script
update_storyboard_first_script
clear_storyboard_first_workflow
generate_storyboard_first_image
generate_storyboard_first_video
```

能力定义：

- `get_storyboard_first_state`：读取当前剧集故事板先行工作流状态。
- `generate_storyboard_first_script`：根据剧本生成故事板先行分镜脚本。
- `update_storyboard_first_script`：写入用户修订后的分镜脚本，并使下游图片/视频过期。
- `clear_storyboard_first_workflow`：清空当前剧集的故事板先行产物。
- `generate_storyboard_first_image`：生成或重生成故事板图片。
- `generate_storyboard_first_video`：根据故事板图生成视频。

工具 schema：

```ts
get_storyboard_first_state({});

generate_storyboard_first_script({
  targetDuration?: number;
  force?: boolean;
});

update_storyboard_first_script({
  firstScriptId: number;
  shotScript: string;
});

generate_storyboard_first_image({
  firstScriptId: number;
  force?: boolean;
});

generate_storyboard_first_video({
  firstImageId: number;
  model: string;
  duration: number;
  resolution: string;
  audio?: boolean;
});

clear_storyboard_first_workflow({
  confirm: true;
});
```

说明：

- Agent 工具的 `projectId/scriptId` 从当前生产工作流上下文读取，不暴露给用户填写，避免误删其他剧集。
- `clear_storyboard_first_workflow` 必须调用 `storyboardFirst/clear`，而不是先调用旧分镜面板清空工具。

每个工具返回值必须包含：

```ts
{
  state: string;
  firstScriptId?: number;
  firstImageId?: number;
  firstVideoId?: number;
  videoId?: number;
  stale?: boolean;
  message: string;
}
```

Agent 决策提示词需要明确：

- 如果用户说“故事板先行工作流”，不能调用分镜面板工具。
- 如果用户说“清空故事板先行”，不能删除 `o_storyboard` 分镜图。
- 故事板先行是独立分支，和视频工作台无关。
- 用户出现“故事板先行/先出故事板/从剧本生成故事板图片/故事板转视频”时，只允许调用 `storyboard_first` 工具。
- 在上述语境中禁止调用 `run_sub_agent_storyboard_panel`、`set_storyboard_panel_from_table`、`generate_storyboard_images`、`clear_storyboard_panel`。

旧工具运行时防护：

- 最近用户消息包含“故事板先行”时，旧分镜面板清空、写入、批量生图工具必须直接拒绝。
- 拒绝信息应提示改用故事板先行工具，而不是继续执行旧流程。
- “故事板先行转视频”是现有“不要由 Agent 直接生成视频”规则的例外。该例外只允许调用 `generate_storyboard_first_video`，仍不得调用主视频工作台批量生成。

建议新增独立执行层技能：

```text
data/skills/production_execution_storyboard_first.md
```

不要把故事板先行塞入现有阶段5/6，否则“故事板”会继续被解释成分镜面板辅助模式。

## 8. 状态流转

### 8.1 分镜脚本

```text
未生成 -> 生成中 -> 已完成
未生成 -> 生成中 -> 生成失败
生成中 -> 已取消
已完成 -> 生成中 -> 已完成
```

### 8.2 故事板图片

```text
未生成 -> 生成中 -> 已完成
未生成 -> 生成中 -> 生成失败
生成中 -> 已取消
已完成 -> 创建新版本生成中 -> 新版本已完成 -> 旧版本和旧视频清理
已完成 -> 创建新版本生成中 -> 新版本生成失败 -> 保留旧版本；是否 stale 由 hash 动态判断
```

### 8.3 故事板视频

```text
未生成 -> 生成中 -> 已完成
未生成 -> 生成中 -> 生成失败
生成中 -> 已取消
已完成 -> 再次生成 -> 新建一条视频历史
```

视频可以保留历史，图片重生成时应删除旧图片关联的视频，避免用旧图生成的视频继续显示为当前结果。

## 9. 提示词策略

### 9.1 分镜脚本提示词

核心要求：

- 从剧本直接拆解镜头，不引用已有分镜图。
- 输出可执行的导演分镜脚本。
- 单镜头不超过 5 秒。
- 6 秒建议 2-3 个镜头，10 秒至少 3-5 个镜头，15 秒建议 4-6 个镜头。
- 台词默认中文。
- 结合项目画风、导演手册、角色资产描述。

### 9.2 故事板图片提示词

沿用现有故事板图片策略，但去掉“候选分镜”依赖。

必须包含：

- 固定 `9:16` 竖版。
- 不拼接现有分镜图。
- 每个镜头卡片要符合项目画风。
- 参考图只用于锁定角色、服装、场景、道具，不直接拼贴。

### 9.3 故事板视频提示词

核心要求：

- 读取故事板图作为单图参考。
- 根据分镜脚本描述镜头运动、角色调度、节奏。
- 针对模型限制生成不同提示词：
  - Grok：支持 `6/10/15s` 时明确约束总时长。
  - Seedance：遵守当前供应商支持的 duration/resolution。
  - 不超过上游 prompt 长度限制。
- 提示词必须优先描述故事板图中的分格镜头顺序，不能把故事板图当作单帧剧照处理。
- 当模型支持 `@图片` 或多模态引用时，提示词中只引用故事板图片本身，不再重复引用全部角色资产，避免图片数量超限。

## 10. 与现有故事板辅助模式的关系

短期建议：

- 保留现有 `storyboardBoardPanel.vue`，但改名为“分镜图辅助故事板模式”。
- 新增“故事板先行工作流”作为独立节点。
- 新节点不能复用旧面板的数据 DTO；旧面板只服务“分镜图辅助故事板”。

中期建议：

- 将 `src/utils/storyboardBoard.ts` 拆成通用模块：

```text
src/utils/storyboard/
├─ common.ts
├─ prompt.ts
├─ image.ts
├─ video.ts
├─ storyboardBoard.ts
└─ storyboardFirst.ts
```

避免两个流程互相污染。

## 11. 迁移策略

无需迁移旧 `o_storyboardBoard` 数据。旧数据仍属于“分镜图辅助模式”。

需要新增 `fixDB.ts/initDB.ts`：

- 创建 `o_storyboardFirstScript`
- 创建 `o_storyboardFirstImage`
- 创建 `o_storyboardFirstVideo`
- 软件启动时把上述三张表和关联 `o_video` 中 `生成中` 的记录改为 `生成失败`，原因写“软件退出导致失败”

示例：

```ts
await db("o_storyboardFirstScript").where("state", "生成中").update({
  state: "生成失败",
  errorReason: "软件退出导致失败",
});
```

### 11.1 DB 初始化和升级验收

必须覆盖三种场景：

- 新库首次启动：`initDB.ts` 创建三张新表和索引。
- 旧库升级：`fixDB.ts` 创建缺失表和缺失字段。
- 清库重建：清库路径重新调用 `initDB.ts` 后仍包含三张新表。

验收 SQL 示例：

```sql
select name from sqlite_master where type='table' and name in (
  'o_storyboardFirstScript',
  'o_storyboardFirstImage',
  'o_storyboardFirstVideo'
);
```

### 11.2 路由生成机制

当前 `src/router.ts` 由 `src/core.ts` 扫描 `src/routes/**/*.ts` 自动生成。实施时必须：

- 新增 `src/routes/production/storyboardFirst/*.ts` 文件。
- 运行项目现有路由生成流程。
- 确认 `src/router.ts` 的 `@routes-hash` 更新。
- 确认包含所有新接口路径：
  - `/api/production/storyboardFirst/list`
  - `/api/production/storyboardFirst/generateScript`
  - `/api/production/storyboardFirst/updateScript`
  - `/api/production/storyboardFirst/generateImage`
  - `/api/production/storyboardFirst/regenerateImage`
  - `/api/production/storyboardFirst/generateVideo`
  - `/api/production/storyboardFirst/delete`
  - `/api/production/storyboardFirst/clear`

### 11.3 项目和剧集删除级联

必须修改：

```text
src/routes/project/delProject.ts
src/routes/script/delScript.ts
```

删除规则：

- 删除项目时，删除该项目下所有 `o_storyboardFirstScript/Image/Video` 记录。
- 删除剧集时，删除该剧集下所有 `o_storyboardFirstScript/Image/Video` 记录。
- 删除图片和缩略图 OSS 文件。
- 删除故事板先行视频关联的 `o_video`，但只能删除 `videoTrackId IS NULL` 且属于本流程的记录。
- 删除前先使相关 `jobToken` 失效，防止后台任务写回。

### 11.4 运行中任务恢复

启动恢复不能只更新新三表，还必须同步 `o_video` 状态：

- `o_storyboardFirstScript.state='生成中'` -> `生成失败`。
- `o_storyboardFirstImage.state='生成中'` -> `生成失败`。
- `o_storyboardFirstVideo.state='生成中'` -> `生成失败`。
- 与 `o_storyboardFirstVideo.videoId` 关联的 `o_video.state='生成中'` -> `生成失败`。
- 如果后续实现上游任务状态恢复，可以基于 `o_video.externalTaskId` 查询上游；MVP 先统一标记失败，避免前端永久卡住。

## 12. 文件清单

后端新增：

```text
src/routes/production/storyboardFirst/list.ts
src/routes/production/storyboardFirst/generateScript.ts
src/routes/production/storyboardFirst/updateScript.ts
src/routes/production/storyboardFirst/generateImage.ts
src/routes/production/storyboardFirst/regenerateImage.ts
src/routes/production/storyboardFirst/generateVideo.ts
src/routes/production/storyboardFirst/delete.ts
src/routes/production/storyboardFirst/clear.ts
src/utils/storyboardFirst.ts
src/utils/storyboardFirstCleanup.ts
```

后端修改：

```text
src/router.ts
src/lib/initDB.ts
src/lib/fixDB.ts
src/utils/storyboardBoard.ts
src/agents/productionAgent/tools.ts
src/agents/productionAgent/index.ts
src/routes/project/delProject.ts
src/routes/script/delScript.ts
```

前端新增：

```text
Toonflow-web/src/views/production/node/storyboardFirstScript.vue
Toonflow-web/src/views/production/node/storyboardFirstImage.vue
Toonflow-web/src/views/production/node/storyboardFirstVideo.vue
Toonflow-web/src/views/production/composables/useStoryboardFirstWorkflow.ts
```

前端修改：

```text
Toonflow-web/src/views/production/utils/flowBuilder.ts
Toonflow-web/src/views/production/index.vue
Toonflow-web/src/views/production/node/script.vue
Toonflow-web/src/views/production/node/storyboardBoardPanel.vue
```

可选修改：

```text
Toonflow-web/src/locales/language/zh-CN.json
Toonflow-web/src/locales/language/en.json
```

## 13. 分阶段实施计划

### 阶段 1：数据表与接口骨架

- 新增三张表。
- 新增 `storyboardFirst/list/delete/clear`。
- 新增基础清理函数 `storyboardFirstCleanup.ts`。
- 路由自动生成并验证 `router.ts` hash。
- 接入 `delProject.ts` 和 `delScript.ts` 级联删除。
- 验证空状态可查询。

验收：

- 新接口可返回当前剧集空数据。
- 删除接口不会影响 `o_storyboard`、`o_storyboardBoard`、`workbench.videoList`。
- 新库启动、旧库升级、清库重建三种场景都有三张新表。
- `router.ts` 包含 8 个新接口。
- 删除项目/剧集后没有新三表残留记录，没有孤儿 OSS 文件。

### 阶段 2：分镜脚本生成

- 实现 `generateScript/updateScript`。
- 接入剧本、项目画风、导演手册、资产描述。
- 支持生成中去重和同源缓存。
- 写入 `inputHash/shotScriptHash/scriptRevision/jobToken`。

验收：

- 输入剧本后能生成结构化分镜脚本。
- 单镜头时长不超过 5 秒。
- 10 秒目标时长输出 3-5 个镜头。
- 双击生成只产生一条 `生成中` 脚本记录。
- 手动编辑脚本后，图片和视频返回 `stale=true`。

### 阶段 3：故事板图片生成

- 实现 `generateImage/regenerateImage`。
- 图片固定 `9:16`。
- 缩略图生成。
- 引用资产图，不引用分镜图。
- 实现图片版本、`imageSourceHash`、`isCurrent`、`stale` 和 `jobToken`。

验收：

- 新图为竖版。
- 图片列表加载缩略图，预览加载原图。
- 重生成图片成功后切换当前版本，并清理旧图片关联的视频；失败时不覆盖当前可用图片。
- 生成失败时旧图片不会被提前删除。
- 删除后旧异步任务完成不会把图片写回当前记录。
- 图片引用不读取 `o_storyboard.filePath`。

### 阶段 4：故事板转视频

- 实现 `generateVideo`。
- 模型筛选单图视频模型。
- 生成确认弹窗。
- 预览与下载使用 `getRenderableVideoSrc`。
- 视频 `aspectRatio` 固定写入并传递为 `9:16`。
- 写入 `imageSourceHash/firstImageVersion/jobToken`。
- 使用模型适配层解析 `duration/resolution`，后端拒绝供应商不支持的尺寸和时长。

验收：

- 可用故事板图生成视频。
- 视频不会出现在主视频工作台轨道里。
- 视频任务失败时错误信息能展示。
- `o_video.videoTrackId IS NULL`。
- `workbench/getVideoList` 不返回故事板先行视频。
- 图片 `stale=true` 时不能发起视频生成。
- 竖版请求不会向供应商传出未支持的尺寸字符串。

### 阶段 5：前端独立节点

- 新增三个节点组件。
- 新增 `useStoryboardFirstWorkflow(projectId, scriptId)` 共享状态。
- 接入 flowBuilder 新分支。
- 自动布局调整。
- `script.vue` 新增独立 `storyboardFirst` handle。
- 旧 `storyboard.vue` 内的 `storyboardBoardPanel` 保留但改名为“分镜图辅助故事板”。

验收：

- UI 中能清晰看到两条分支。
- 故事板先行工作流不依赖分镜图节点。
- 切换剧集后状态正确刷新。
- 三个节点共享一次轮询，不重复请求。
- 自动布局后 `assets` 和故事板先行分支不重叠。
- 脚本更新后，图片/视频节点展示“需重新生成”。

### 阶段 6：Agent 工具

- 新增故事板先行工具。
- 修改决策提示词。
- 支持“清空故事板先行工作流并重新生成”。
- 给旧分镜面板工具增加“故事板先行”语境运行时拒绝。

验收：

- Agent 不再误调用分镜面板工具。
- Agent 可按三步执行完整故事板先行流程。
- 用户说“故事板先行转视频”时，Agent 只允许调用 `generate_storyboard_first_video`，不能调用主视频工作台工具。

## 14. 风险与处理

风险 1：继续复用旧 `o_storyboardBoard` 导致边界混乱。

处理：新建独立表，仅复用通用工具函数。

风险 2：前端节点太多导致画布拥挤。

处理：新分支放在主流程下方，并改进自动布局。

风险 3：故事板图片和项目画风不一致。

处理：图片提示词中强化项目画风优先级，并把资产图作为优先参考。

风险 4：视频模型 prompt 超长。

处理：视频提示词按字节长度截断，模型适配层设置上限。

风险 5：重启导致生成中状态卡死。

处理：启动时统一把故事板先行三张表和关联 `o_video` 的 `生成中` 记录置为 `生成失败`。

风险 6：旧异步任务在删除或重生成后写回。

处理：所有异步任务使用 `jobToken` 条件写回，删除和重生成会使旧 token 失效。

风险 7：脚本修改后继续使用旧图片/旧视频。

处理：使用 `shotScriptHash/imageSourceHash/stale` 做下游失效判断，前端禁止基于过期图片生成视频。

风险 8：新增路由手动修改后被自动生成覆盖。

处理：实施时必须运行路由生成流程并验证 `@routes-hash`。

## 15. 验收清单

- `剧本 -> 分镜脚本` 不依赖分镜面板。
- `分镜脚本 -> 故事板图片` 固定生成竖版 `9:16`。
- `故事板图片 -> 视频` 固定使用 `9:16`，不写入主视频工作台。
- 新分支与当前主流程并列存在。
- 删除故事板先行产物不会删除分镜面板、分镜图、主视频轨道。
- 新故事板图片生成成功后，会清理旧图片关联的视频。
- 前端列表默认加载缩略图，预览才加载原图。
- Agent 能区分“分镜图流程”和“故事板先行流程”。
- 服务重启后不会留下永久 `生成中` 状态。
- `list` 接口只返回一种聚合结构，包含 `script/image/latestVideo/videoHistory/stale`，其中 `stale` 由 hash 动态计算。
- 双击生成不会创建重复运行任务。
- 删除后旧后台任务完成不会恢复已删除记录。
- 项目删除、剧集删除会清理新三表、OSS 文件和关联 `o_video`。
- 新库、旧库升级、清库重建都能创建三张新表。
- `router.ts` 自动生成后包含 8 个故事板先行接口。
- 旧 `storyboardBoardPanel.vue` 保留为“分镜图辅助故事板”，新节点不复用它的数据边界。
