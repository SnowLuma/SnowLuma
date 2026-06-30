# SnowLuma Pixiv 插件

> 原 [napcat-plugin-pixiv](https://github.com/ShiYuPIay/napcat-plugin-pixiv.git) 已全面适配 **SnowLuma** 框架（基于 `@snowluma/sdk` 的独立 OneBot v11 客户端），0 TypeScript 报错。

## 为什么需要适配？

| | NapCat | SnowLuma |
|---|---|---|
| **架构** | 进程内插件加载器（`plugin_init` / `plugin_onmessage` 生命周期） | OneBot v11 实现，通过 HTTP / WebSocket 暴露能力 |
| **调用方式** | `ctx.actions.call(action, params, adapterName, pluginManagerConfig)` | `@snowluma/sdk` 类型化客户端（`bot.sendGroupMessage` / `bot.raw` / `bot.sendForwardMessage`） |
| **配置面板** | `ctx.NapCatConfig.boolean/text/number` + WebUI | 文件 `config.json` + 环境变量 |
| **事件接入** | 框架回调 `plugin_onmessage(ctx, event)` | `bot.onMessage((event, ctx) => …)` 订阅 |
| **运行模型** | 由 NapCat 加载 | 独立进程，连接到运行中的 SnowLuma 实例 |

SnowLuma **没有** NapCat 那样的进程内插件加载器。因此适配方案是把原插件改造成一个**独立的 SnowLuma SDK 客户端应用**：它通过 WebSocket 连接到 SnowLuma 暴露的 OneBot 端点，订阅消息事件，再用类型化的 SDK 方法发送回复与合并转发。

## 功能（与原插件一致）

- 关键词搜索：`#pixiv<关键词>`
- 随机推荐：`#pixivrec` / `#pixiv推荐`
- 日榜 Top10：`#pixiv日榜` / `!pixiv日榜`
- 健康检查：`#pixivstatus`
- 帮助说明：`#pixivhelp`
- 合规提示：`#pixiv合规`
- 多图合并转发：优先使用 `send_group_forward_msg`，失败自动回退 `send_forward_msg`

## 环境要求

- **Node.js ≥ 22**（`@snowluma/sdk` 要求）
- 运行中的 **SnowLuma** 实例，且已启用 OneBot HTTP（`0.0.0.0:3000`）/ WebSocket（`0.0.0.0:3001`）适配器
- 网络可访问 `https://api.lolicon.app` 与 `https://api.obfs.dev`

## 安装

```bash
cd snowluma-plugin-pixiv
npm install        # 或 bun install / pnpm install
npm run build      # tsc 编译到 dist/
```

## 配置

复制示例配置并按需修改：

```bash
cp config.example.json config.json
```

```json
{
  "plugin": {
    "enabled": true,
    "commandPrefix": "#pixiv",
    "maxResults": 3,
    "allowR18": false,
    "enableForward": true,
    "enableAnonymousForward": false,
    "rateLimitSeconds": 15,
    "blockedKeywords": "萝莉,未成年,幼女,乱伦,强奸"
  },
  "connection": {
    "wsUrl": "ws://127.0.0.1:3001/",
    "httpUrl": "http://127.0.0.1:3000/",
    "accessToken": "",
    "requestTimeoutMs": 30000,
    "reconnect": true
  }
}
```

### 环境变量覆盖

| 变量 | 说明 |
|---|---|
| `SNOWLUMA_WS_URL` | WebSocket 端点 |
| `SNOWLUMA_HTTP_URL` | HTTP 端点（fallback） |
| `SNOWLUMA_TOKEN` | OneBot access token |
| `SNOWLUMA_REQUEST_TIMEOUT_MS` | 请求超时（ms） |
| `SNOWLUMA_RECONNECT` | 是否自动重连 |
| `SNOWLUMA_PIXIV_ENABLED` | 启用插件 |
| `SNOWLUMA_PIXIV_COMMAND_PREFIX` | 指令前缀 |
| `SNOWLUMA_PIXIV_MAX_RESULTS` | 最大结果数 |
| `SNOWLUMA_PIXIV_ALLOW_R18` | 允许 R18 |
| `SNOWLUMA_PIXIV_ENABLE_FORWARD` | 启用合并转发 |
| `SNOWLUMA_PIXIV_RATE_LIMIT_SECONDS` | 限流秒数 |
| `SNOWLUMA_PIXIV_BLOCKED_KEYWORDS` | 拦截关键词 |
| `SNOWLUMA_PIXIV_LOG_LEVEL` | 日志级别（debug/info/warn/error） |

## 运行

```bash
npm start          # node dist/index.js
# 或
npm run dev        # node --watch dist/index.js（文件变更自动重启）
```

## API 适配映射

| 原 NapCat 调用 | SnowLuma SDK 适配 |
|---|---|
| `plugin_init(ctx)` | `main()` → `bot.connect()` |
| `plugin_onmessage(ctx, event)` | `bot.onMessage((event) => handleMessage(bot, event))` |
| `ctx.actions.call('send_msg', {message_type, group_id/user_id, message})` | `bot.sendGroupMessage(groupId, msg)` / `bot.sendPrivateMessage(userId, msg)` |
| `ctx.actions.call('send_group_forward_msg', {group_id, messages, prompt, summary, source, news})` | `bot.sendForwardMessage({ group_id, messages, prompt, summary, source, news })` → 回退 `bot.raw('send_group_forward_msg', …)` → `bot.raw('send_forward_msg', …)` |
| `ctx.actions.call('send_private_forward_msg', …)` | `bot.sendForwardMessage({ user_id, … })` → 同上回退链 |
| `ctx.logger.info/warn/error/debug` | `createLogger()`（带级别与颜色） |
| `ctx.NapCatConfig.*` 配置 Schema | `PLUGIN_CONFIG_FIELDS` + `config.json` + 环境变量 |
| `ctx.pluginData.config` 持久化 | `savePluginConfig()` 写 `config.json` |
| 消息段 `{type:'text',data:{text}}` / `{type:'image',data:{file}}` | `message.text()` / `message.image()`（类型化 MessageChain） |
| 转发节点 `{type:'node',data:{user_id,nickname,content}}` | `message.node(userId, nickname, content)` |
| `event.self_id` | `event.self_id`（OneBot 事件结构一致）+ `bot.getLoginInfo()` 兜底 |

## 目录结构

```
snowluma-plugin-pixiv/
├─ src/
│  ├─ index.ts                    # 主入口：建客户端、订阅事件、连接
│  ├─ config.ts                   # 配置加载/校验/持久化/环境变量覆盖
│  ├─ logger.ts                   # 带级别的日志器
│  ├─ types.ts                    # 共享类型
│  ├─ core/
│  │  └─ state.ts                 # 全局状态（配置/日志/客户端引用）
│  ├─ handlers/
│  │  └─ message-handler.ts       # 消息处理（核心适配逻辑）
│  └─ services/
│     └─ pixiv-service.ts         # Pixiv 第三方 API（与运行时无关）
├─ config.example.json
├─ package.json
├─ tsconfig.json
└─ README.md
```

## 许可证

AGPL-3.0-only
