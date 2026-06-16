# Toonflow AI 维护注意事项

本文档给后续 AI 维护代理使用，记录当前服务器部署和易错点。

## 当前部署

- 项目目录：`/soft/Toonflow`
- Web 域名：`https://toonflow.einzieg.site/`
- Toonflow 容器：`toonflow`
- 容器镜像：`toonflow:prod`
- 后端监听：容器内 `18080`，宿主机仅绑定 `127.0.0.1:18080`
- OpenResty 反代：`toonflow.einzieg.site` 的 `/`、`/api`、`/socket.io/` 均代理到 `http://127.0.0.1:18080`
- 运行时数据挂载：宿主 `/soft/Toonflow/data` 挂载到容器 `/app/data`

## 前端网络规则

- Web 端必须使用同源 `/api`，不要使用前端设置里的自定义 API 地址。
- Electron 桌面端才允许使用 `toonflow://getAppUrl` 返回的本机后端地址。
- 旧前端包会直接读取 persisted `baseUrl`，如果用户本地保存过 `http://localhost:10588` 或旧域名，会出现 `Network Error`。
- 当前源码已在 `Toonflow-web/src/utils/axios.ts` 中区分 Web 和 Electron 的网络错误提示，避免 Web 端误提示“管理员/Visual C++”。

## Network Error 排查

优先确认反代链路，而不是先怀疑模型服务：

```bash
curl -k -i https://toonflow.einzieg.site/api/other/getVersion
```

期望结果是 `401` 且返回 `{"message":"未提供token"}`，这表示请求已经到达 Toonflow 后端。

如果用户浏览器仍弹网络错误，先让用户清理旧前端持久化配置：

```js
localStorage.removeItem("setting")
location.reload()
```

不要让 Web 端连接 `10588`。`10588` 是默认本地开发/桌面端端口，当前服务器没有对公网暴露。

## 部署注意

- 只改源码不会影响线上页面，因为容器运行时读取的是挂载目录 `data/web/index.html` 和 `data/serve/app.js`。
- 前端改动后需要重新构建并同步到 `data/web`。
- 后端改动后需要重新构建 `data/serve/app.js`。
- 重启容器前确认没有正在生成的任务，避免中断长任务。
- 重启后用域名验证 `/api/other/getVersion` 和 `/socket.io/?EIO=4&transport=polling`。

## OpenResty 配置要点

- `/socket.io/` 需要支持 `Upgrade`，并保持较长 `proxy_read_timeout`。
- 大文件上传或多图参考需要足够的 `client_max_body_size`，当前配置为 `512m`。
- 反代目标应是 `http://127.0.0.1:18080`，不要改成容器未暴露的 `10588`。

## 故事板不是分镜图拼接

- 故事板辅助单图模式的正确流程是：`剧本 + 分镜文本 + 资产描述 + 目标时长 -> Agent 自动分割 -> 分镜头脚本 -> 单页故事板图片 -> 单图生视频`。
- 故事板分割应由 Agent 根据剧情节拍、动作连续性、台词完整性、场景转换和目标视频时长自动判断；不要在前端暴露固定“每页 N 个镜头”的机械切分配置。
- 不要把 `o_storyboard.filePath` 的分镜图直接拼成故事板图；分镜图不是故事板生成的必需输入。
- 但故事板图片生成可以把已有分镜图和关联资产图作为参考图传给图片模型，用于锁定实际画风、角色、服装、场景和道具；参考图不能被直接拼贴到故事板页中。
- 创建故事板时应先生成并保存 `o_storyboardBoard.shotScript`，再用图片模型根据 `shotScript` 生成类似导演分镜头脚本页的图片。
- 故事板图片必须支持重新生成。重新生成应复用当前 `shotScript`，替换图片文件，并清理该故事板下的旧视频记录，避免新图对应旧视频。
- 视频生成时不能只依赖故事板图片，必须把 `shotScript` 放入视频提示词，保证镜头顺序、时长、台词和运镜可控。
- 前端选择故事板来源时不要用 `item.src` 过滤分镜；没有分镜图但有分镜文本的镜头也应可生成故事板。
