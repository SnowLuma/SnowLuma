# @snowluma/sdk

SnowLuma 的 TypeScript SDK，提供 OneBot HTTP / WebSocket 客户端、事件中间件、命令匹配和消息链式构造器。

## 导航

- [安装](#安装)
- [快速开始](#快速开始)
- [HTTP Client](#http-client)
- [WebSocket Client](#websocket-client)
- [事件中间件与命令](#事件中间件与命令)
- [Raw Action](#raw-action)
- [Message Builder](#message-builder)
- [请求控制](#请求控制)
- [错误处理](#错误处理)
- [测试建议](#测试建议)
- [子路径导入](#子路径导入)
- [Action 同步](#action-同步)
- [项目结构](#项目结构)
- [版本策略](#版本策略)

## 安装

在本 monorepo 内直接通过 workspace 引用：

```bash
pnpm add @snowluma/sdk --workspace
```

发布到 npm 后可直接安装：

```bash
pnpm add @snowluma/sdk
```

## 快速开始

```ts
import { SnowLumaHttpClient, text } from '@snowluma/sdk';

const bot = new SnowLumaHttpClient({
  baseUrl: 'http://127.0.0.1:3000/',
  accessToken: process.env.SNOWLUMA_TOKEN,
});

const login = await bot.getLoginInfo();
await bot.sendGroupMessage(123456, text(`Hello from ${login.nickname}`).at('all'));
```

SnowLuma 的 OneBot HTTP / WebSocket 端口和 `accessToken` 来自 `config/onebot_<uin>.json`。

## HTTP Client

```ts
import { SnowLumaHttpClient, message, text } from '@snowluma/sdk';

const bot = new SnowLumaHttpClient({
  baseUrl: 'http://127.0.0.1:3000/',
  accessToken: process.env.SNOWLUMA_TOKEN,
  requestTimeoutMs: 30_000,
});

await bot.sendPrivateMessage(10001, text('pong'));

await bot.sendGroupMessage(123456, [
  message.text('Hello'),
  message.at('all'),
]);
```

## WebSocket Client

WebSocket 客户端会用 `echo` 关联 API 响应，并把无 `echo` 的包作为事件分发。

```ts
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';

const bot = new SnowLumaWebSocketClient({
  url: 'ws://127.0.0.1:3001/',
  accessToken: process.env.SNOWLUMA_TOKEN,
  reconnect: true,
});

bot.onGroupMessage(async (event, ctx) => {
  if (event.raw_message === '/ping') {
    await ctx.reply(text('pong').at(event.user_id));
  }
});

bot.onRequest('friend', async (_event, ctx) => {
  await ctx.approve();
});

bot.onBotStatus((event) => {
  console.log(event.sub_type, event.user_id);
});

await bot.connect();
await bot.sendPrivateMessage(10001, text('ready'));
```

## 事件中间件与命令

```ts
bot.use(async (event, ctx, next) => {
  console.log(event.post_type);
  await next();
});

bot.command('echo', async (_event, ctx, match) => {
  await ctx.reply(text(match.rest || 'empty'));
});

bot.when(
  (event) => event.post_type === 'notice',
  async (event) => console.log(event),
);
```

事件上下文内置快捷操作：

- `ctx.reply(message)`：按私聊/群聊自动回复。
- `ctx.approve()` / `ctx.reject(reason)`：处理好友或群请求。
- `ctx.quickOperation(operation)`：调用 `.handle_quick_operation`。
- `ctx.stopPropagation()`：停止后续中间件和普通 `onEvent` 分发。

## Raw Action

高频接口提供 camelCase 方法；其它 SnowLuma action 可以用 `raw` 或 `rawResponse`：

```ts
const data = await bot.raw('get_group_file_system_info', {
  group_id: 123456,
});

const response = await bot.rawResponse('get_status');
```

`raw` 会在 SnowLuma 返回 `status: "failed"` 或非零 `retcode` 时抛出 `SnowLumaApiError`；`rawResponse` 会保留完整响应。

## Message Builder

```ts
import { fromCQString, message, text, toCQString } from '@snowluma/sdk';

const segments = [
  message.reply(42),
  message.text('收到 '),
  message.image('https://example.com/a.png'),
];

const chained = text('收到 ')
  .at(10001)
  .image('https://example.com/a.png');

const cq = toCQString(segments);
const chainedCq = toCQString(chained);
const parsed = fromCQString('hi[CQ:at,qq=all]');
```

链式入口返回 `MessageChain`，可以直接传给发送接口，也可以用 `build()` / `toSegments()` 转成 OneBot segment 数组：

```ts
await bot.sendGroupMessage(123456, text('hi').at(10001).image('/tmp/a.png'));

const segments = text('hi').at('all').build();

await text('hi').atAll().br().face(14).sendToGroup(bot, 123456);
```

`reply()` 在一条链中只能出现一次；TypeScript 会阻止 `text('a').reply(1).reply(2)`，运行时也会做同样检查。

已内置常用段：`text`、`br`、`face`、`at`、`atAll`、`reply`、`image`、`record`、`video`、`json`、`xml`、`poke`、`forward`、`node`、`share`、`music`、`location`、`contact` 和 `raw`。

## 请求控制

每次请求都支持覆盖 `echo`、超时和 `AbortSignal`：

```ts
const controller = new AbortController();

const status = bot.getStatus({
  echo: 'healthcheck',
  timeoutMs: 5_000,
  signal: controller.signal,
});

controller.abort();
await status;
```

`timeoutMs: 0` 表示关闭该请求的超时控制。

## 错误处理

SDK 暴露统一错误基类和更具体的错误类型：

- `SnowLumaApiError`：OneBot 响应失败或 `retcode !== 0`。
- `SnowLumaAuthError`：鉴权相关 retcode，例如 `1401`、`401`、`403`。
- `SnowLumaTransportError`：连接、解析、超时、取消等传输层错误基类。
- `SnowLumaConnectionError`：HTTP fetch / WebSocket 连接或发送失败。
- `SnowLumaParseError`：响应不是合法 JSON 或不符合 OneBot 响应结构。
- `SnowLumaTimeoutError`：请求超过 `timeoutMs`。
- `SnowLumaAbortError`：调用方通过 `AbortSignal` 主动取消。

```ts
import {
  SnowLumaApiError,
  SnowLumaAuthError,
  SnowLumaTimeoutError,
} from '@snowluma/sdk';

try {
  await bot.getStatus({ timeoutMs: 1000 });
} catch (error) {
  if (error instanceof SnowLumaAuthError) {
    throw new Error('SnowLuma access token is invalid');
  }
  if (error instanceof SnowLumaTimeoutError) {
    console.warn(`SnowLuma did not respond in ${error.timeoutMs}ms`);
  }
  if (error instanceof SnowLumaApiError) {
    console.warn(error.retcode, error.wording);
  }
}
```

## 测试建议

- SDK 自身使用 Vitest 覆盖消息构造、事件上下文、WebSocket 响应关联、错误模型和取消逻辑。
- 对接真实 SnowLuma 时建议使用单独测试账号和测试群，避免把自动化消息发到生产环境。
- 集成测试里优先显式设置 `echo` 和较短 `timeoutMs`，这样失败时更容易定位是哪一次 action。
- 发布前运行 `pnpm --filter @snowluma/sdk typecheck`、`pnpm --filter @snowluma/sdk test`、`pnpm --filter @snowluma/sdk build`。

## 子路径导入

```ts
import { SnowLumaHttpClient } from '@snowluma/sdk/client';
import { text } from '@snowluma/sdk/messages';
import { isMessageEvent } from '@snowluma/sdk/events';
import { SnowLumaApiError } from '@snowluma/sdk/errors';
```

根入口 `@snowluma/sdk` 仍导出正式公开 API；不再保留旧的根级兼容 barrel 或别名 API。

## Action 同步

SDK 导出 `SNOWLUMA_ACTIONS` 和 `isSnowLumaAction()`。测试会扫描 `packages/core/src/onebot/actions/*.ts` 的 `registerAction()`，确保 SDK action 列表没有落后。

## 项目结构

```text
src/
  client/      HTTP / WebSocket client 与 API facade
  events/      事件上下文、类型守卫、中间件和命令匹配
  messages/    segment 工厂、MessageChain、CQ 编解码
  types/       JSON、消息、事件、action 参数和返回类型
  internal/    SDK 内部工具
```

## 版本策略

当前包版本为 `0.1.0`。版本规则、发布检查清单和破坏性变更边界见 [VERSIONING.md](./VERSIONING.md)。
