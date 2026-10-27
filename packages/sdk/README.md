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

### 读取与修改空间资料

`get_qzone_profile` 返回 QQ 空间的名称和说明；这两个字段独立于 QQ 昵称和个性签名。

```ts
const profile = await bot.raw('get_qzone_profile', {}); // 当前账号
console.log(profile.name, profile.description);
await bot.raw('get_qzone_profile', { target_uin: '10002' });

await bot.raw('set_qzone_profile', { name: '我的空间' });
await bot.raw('set_qzone_profile', { description: '' }); // 清空说明
```

`set_qzone_profile` 只修改当前账号，至少提供 `name`、`description` 中的一项；省略字段保持原值，空字符串表示清空。成功返回 `null`，登录失效、访问受限或上游要求验证时会抛出 `SnowLumaApiError`。修改后可再次读取资料确认结果。

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

### 空友爱看与公共空间

公共空间动作使用推荐域 `3` 的 JSON 接口，与上面的旧空间 CGI 动作分开。先读取 `get_qzone_public_feeds`，再把返回的完整 `feed` 对象传给详情和互动动作，保留其中的身份、传递数据及未知字段；不要用旧说说 `tid` 拼造。

| 动作 | 主要参数 |
| --- | --- |
| `get_qzone_public_capabilities` | 无；读取当前账号的入口能力 |
| `get_qzone_public_feeds` | 可选 `cursor` |
| `get_qzone_public_feed_detail` | `feed` |
| `get_qzone_public_comments` | `feed`、`cursor` |
| `get_qzone_public_replies` | `feed`、完整 `comment`，可选 `cursor`、`page_size`（默认 20） |
| `set_qzone_public_upvote` / `set_qzone_public_like` / `set_qzone_public_follow` | `feed`，可选 `enable`（默认 `true`，`false` 取消） |
| `set_qzone_public_comment_like` | `feed`、完整 `comment`，可选完整 `reply`、`enable`（默认 `true`） |
| `comment_qzone_public_feed` | `feed`、`content` |
| `reply_qzone_public_feed` | `feed`、完整 `comment`、`content`，可选完整 `reply` |
| `delete_qzone_public_comment` / `delete_qzone_public_reply` | `feed`、完整 `comment`；删除回复还需完整 `reply` |
| `forward_qzone_public_feed` | `feed`，可选 `reason`（默认空字符串） |

“推”与“赞”是不同的互动，分别使用 `set_qzone_public_upvote` 和 `set_qzone_public_like`。评论或回复的 `content` 接受非空文本或非空的上游富文本对象数组。详情、评论、回复及写操作保留上游结果字段，`raw` 返回这些 JSON 对象；列表的 `feeds` 已去掉上游每项的 `.feed` 包装，其余字段保持开放。

QQ 上游会对评论换行做归一化，返回的富文本保持上游格式。

`set_qzone_public_comment_like` 为评论点赞；提供 `reply` 时改为给该回复点赞，`enable: false` 取消。保留评论或回复自带的 `like.id`，不要将它替换成评论 ID。

```ts
const page = await bot.raw('get_qzone_public_feeds', {});
if (page.has_more && page.next_cursor) {
  const next = await bot.raw('get_qzone_public_feeds', { cursor: page.next_cursor });
  console.log(next.feeds);
}

const feed = page.feeds[0];
if (feed) {
  const detail = await bot.raw('get_qzone_public_feed_detail', { feed });
  if (detail.has_more === true && typeof detail.attach_info === 'string') {
    const comments = await bot.raw('get_qzone_public_comments', {
      feed,
      cursor: detail.attach_info,
    });
    console.log(comments);
  }
}
```

列表续页必须原样传回 `next_cursor`，根据 `has_more` 判断结束，不能因本页不足 10 条而停止。详情中的首批评论位于 `feed.feed.cell_comment.comments`；后续评论使用详情或上一评论页的 `attach_info` 作为 `cursor`。读取回复时，首次可省略 `cursor` 使用完整评论自带的 `reply_attach_info`，之后传上一回复页的 `reply_attach_info`。这些游标各有用途，列表游标还绑定当前账号。登录或访问权限失败会抛出 `SnowLumaApiError`。

### 单个管理员权限

`set_group_admin` 用于授予或取消管理员身份。对已有管理员，可通过以下动作读取或修改权限；调用账号需要具有 QQ 服务端要求的管理权限。

| 动作 | 参数与结果 |
| --- | --- |
| `get_group_admin_permissions` | `group_id`、`user_id`；返回撤回权限、移除权限、每日移除上限和接收验证消息状态 |
| `set_group_admin_permissions` | `group_id`、`user_id`，以及至少一个 `recall_member_message` / `kick_member` |
| `set_group_admin_receive_verify` | `group_id`、`user_id`、必填 `enable`；独立设置接收加群验证消息 |

```ts
await bot.raw('set_group_admin_permissions', {
  group_id: 123456,
  user_id: 10001,
  recall_member_message: false,
  kick_member: true,
  kick_member_per_day: 20,
});

const permissions = await bot.raw('get_group_admin_permissions', {
  group_id: 123456,
  user_id: 10001,
});

await bot.raw('set_group_admin_receive_verify', {
  group_id: 123456,
  user_id: 10001,
  enable: false,
});
```

只修改显式提供的权限。开启移除权限必须明确提供 `kick_member_per_day`，支持 `0`、`5`、`10`、`20`、`50`、`100`、`200`，其中 `0` 表示不限。修改上限也须同时传 `kick_member: true`；关闭或省略移除权限时不能提供上限。SDK 的 `kick_member` 使用布尔值，以便类型检查约束上限。

读取结果包含 `group_id`、`user_id`、`recall_member_message`、`kick_member`、`kick_member_per_day`、`receive_verify`。`receive_verify` 表示是否接收加群验证消息。服务器未返回或未指定的状态为 `null`；移除权限关闭或未指定时，上限也为 `null`。各项来自独立查询，不保证同一时刻的状态；任何查询失败都会报错。

两个写动作分别发送一次请求，不自动重试或授予管理员身份。权限写入成功表示服务器确认请求；接收验证消息写入还会核对响应中的群号和成功管理员列表。两者均返回 `null`。完整的客户端显示和实际权限效果仍需真实 QQ 验证，不能以接口成功替代验收。

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
