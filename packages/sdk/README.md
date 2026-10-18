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

const { url } = await bot.getGroupShareLink(123456);

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

动画系统表情可通过 `face(id, { resultId: '0' })` 指定结果，收到的结果保留在 `face.data.resultId` 中。不传时沿用默认选择；有效结果取决于具体表情，不能与 `large: false` 同用。

`await bot.getStatus()` 的 `time` 为当前账号服务实例的运行秒数，与 `#sl` 使用相同计时起点；实例重建后重新计时。

高频接口提供 camelCase 方法；其它 SnowLuma action 可以用 `raw` 或 `rawResponse`：

```ts
const data = await bot.raw('get_group_file_system_info', {
  group_id: 123456,
});

const response = await bot.rawResponse('get_status');
```

`raw` 会在 SnowLuma 返回 `status: "failed"` 或非零 `retcode` 时抛出 `SnowLumaApiError`；`rawResponse` 会保留完整响应。

### 读取空间说说评论

`get_qzone_msg_detail` 是只读扩展动作，`raw` 提供参数和结果类型：

```ts
const detail = await bot.raw('get_qzone_msg_detail', {
  tid: '说说 ID', // 来自 get_qzone_msg_list / send_qzone_msg
  // target_uin: 10001, // 省略时读取机器人自己的空间
  pos: 0,
  num: 20,
});

for (const comment of detail.comments) {
  console.log(comment.comment_id, comment.uin, comment.name, comment.time, comment.content);
  console.log(comment.replies); // 服务端内联返回的二级回复
}
```

`comment_num` 是服务端报告的总数，`comments` 是本页一级评论；`num` 范围为 1–100，实际返回数量可能更少。二级回复不单独分页，`replies` 不保证完整。评论 ID 在所属说说内唯一，二级回复 ID 在父评论内唯一；时间均为 Unix 秒，正文保留空间表情和 @ 标记。该接口复用当前账号的空间登录态，登录或访问权限失败会抛出 `SnowLumaApiError`。

分页参数及 `commentlist` / `list_3` 字段参考 [Qzone-API](https://github.com/SmartHypercube/Qzone-API/blob/master/qzone.py)。实际分页和可见内容取决于 QQ 空间服务端。

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

CQ 转换会保留参数中的字面量转义文本，例如图片路径中的 `&#44;`，不会将它再次解码成逗号。

链式入口返回 `MessageChain`，可以直接传给发送接口，也可以用 `build()` / `toSegments()` 转成 OneBot segment 数组：

```ts
await bot.sendGroupMessage(123456, text('hi').at(10001).image('/tmp/a.png'));

const segments = text('hi').at('all').build();

await text('hi').atAll().br().face(14).sendToGroup(bot, 123456);
```

`reply()` 在一条链中只能出现一次；TypeScript 会阻止 `text('a').reply(1).reply(2)`，运行时也会做同样检查。

已内置常用段：`text`、`br`、`face`、`at`、`atAll`、`reply`、`image`、`record`、`video`、`json`、`xml`、`poke`、`forward`、`node`、`share`、`music`、`location`、`contact` 和 `raw`。

### 合并转发中的自定义引用

合并转发节点的 `content` 支持 `reply.data.message`，无需引用目标已存在于本地消息库。
SDK 提供 `message.customReply()`（返回消息段，仅用于转发节点）：

```ts
await bot.raw('send_group_forward_msg', {
  group_id: 123456,
  messages: [message.node(10001, '发送者', [
    message.customReply([message.text('SnowLuma')], { qq: 10002, time: 1700000000, seq: 42 }),
    message.text('这是回复内容'),
  ])],
});
```

对应的 OneBot JSON 为 `{ "type": "reply", "data": { "message": [{ "type": "text", "data": { "text": "SnowLuma" } }] } }`。
`message` 可以是文本/CQ 字符串、单个消息段或消息段数组，不能为空；显式提供时优先于 `id`。
引用预览保留文字和 @，图片、表情、语音、视频、文件、转发、JSON/XML 卡片和 Markdown 使用类型文字摘要，不会为引用重新上传媒体。
引用内容不支持嵌套 `reply`/`node` 或 `music`、`contact`、`poke` 等其他类型；无效内容会返回参数错误。

`qq`、`time`、`seq` 支持整数或整数字符串。省略时分别使用当前节点发送者、节点时间（未指定时为当前时间）和 `1`。
`qq` 必须是正安全整数，`time` 是 0 到 4294967295 的 Unix 秒，`seq` 是 1 到 4294967295 的序号。
这些字段用于引用预览；自定义引用不保证能在 QQ 中跳转到原消息。请使用 JSON 消息段传递此扩展；SDK 的 `toCQString` 会拒绝将嵌套消息段转换成 CQ 参数，避免内容被转成 `[object Object]`。

`get_forward_msg` 的回复段仍含 `id`；当 QQ 返回内嵌引用内容时，还会包含 `message` 以及可用的 `qq`、`time`、`seq`。
将返回节点的 `message` 作为新转发节点的 `content` 即可保留引用预览，无需再通过 `get_msg` 查询引用 ID。
若 QQ 没有提供引用内容，则只返回原有 `id`。普通群聊/私聊的 `reply.data.id` 用法保持不变。

## 请求控制

每次请求都支持覆盖 `echo`、超时和 `AbortSignal`：

WebSocket 并发请求必须使用不同的 `echo`；重复值会被拒绝。省略时由 SDK 自动生成。

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
