# SnowLuma v3 — 目标架构

> v2 已完成：UID/UIN Service（SQLite 持久化）、tsx+map Debug、包拆分、proto-defs 剥离、消息 hot-path 优化（17.5μs → 4.7μs）、NapCat 风格 Api 层、Bridge/Account 分层（v2 发布在 `@snowluma/bridge`，v3 重命名为 `@snowluma/channel`）。

---

## 0. 数据流总览（一图概览所有权）

```
┌─ @snowluma/channel-hook ─────────┐    ┌─ @snowluma/channel-socket ──────┐
│ HookManager + HookChannel       │    │ SocketChannel (future)         │
│ — 仅 send/recv + pid/hook state — │   │ — 仅 send/recv + socket state — │
└────────────┬─────────────────────┘    └─────────────┬───────────────────┘
             │ Channel 实例                            │
             └───────────┬──────────────────────────┘
                         │ 通过 ChannelAdapter 注册
                         ▼
┌─ @snowluma/core ──── Hub（主入口 / 持有一切）──────────────┐
│                                                                       │
│  内部：Map<uin, Core>                                                  │
│                                                                       │
│  channel available  ──►  ctx = capability(channel)                       │
│                    ──►  core = new Core(ctx)                           │
│                    ──►  emit 'core-online' { uin, apis, events, ... } │
│                                                                       │
│  channel gone       ──►  core.dispose() + emit 'core-offline' { uin }  │
└─────────────────────────────────────┬─────────────────────────────────┘
                                      │ 顶层 lifecycle 事件（仅 2 个）
                                      ▼
┌─ @snowluma/onebot ──────────────────────────────────────────────────────┐
│ hub.events.on('core-online', ctx => {                                    │
│   this.byUin.set(ctx.uin, ctx);                                         │
│   ctx.events.on('group_message', e => …);    // 每账号 bus              │
│ });                                                                     │
│ // 处理 OneBot action：                                                  │
│   this.byUin.get(uin)?.apis.message.sendGroup(...)                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**核心约定**：
- `Channel` / adapter 包 **只**做 send/recv + 自己的内部状态（pid set / hook session / socket fd）。完全无业务。
- `Hub` 是**主入口**，独占持有 Channels + Cores。`Core` 实例由它构造，外部拿不到 Core 类本身。
- `Core` 通过 **ctx**（capability，一个 POJO）拿到 send/recv，从不直接持有 Channel。
- 外部消费者（OneBot / WebUI）只拿 `CoreCtx`（Core 的对外投影：`{ uin, apis, events, identity }`），不知道 Core 类的存在。
- 每个账号一个 `events`（在 Core 上），不做全局 bus；Hub 只 emit 两个顶层生命周期事件。

---

## 1. 目标包结构

```
SnowLuma/
├── packages/
│   │
│   │  ── Infrastructure（无业务） ──
│   ├── common/             logger / packet-sender / protocol-types / async-context
│   ├── proto-defs/         protobuf TS 接口定义
│   ├── proton/             protobuf codec 编译时生成器
│   ├── runtime/            native .node 产物清单
│   ├── ui/                 Tailwind v4 + shadcn 组件（前端）
│   │
│   │  ── Protocol（解析层，纯函数） ──
│   ├── protocol/           events / identity-service / msg-push / oidb / highway /
│   │                       element-builder / packet-pipeline / event-bus
│   │
│   │  ── Channel & adapters（transport 端口与实现） ──
│   ├── channel/             ⭐ Channel 接口 + 抽象类 + ChannelAdapter 端口
│   │                       —— 只定义接口和最小抽象，**不**含 Hub
│   ├── channel-hook/       ⭐ HookManager + HookChannel + HookAdapter
│   │                       —— 现 @snowluma/channel 大部分内容搬来
│   ├── channel-socket/     ⭐ 未来：SocketChannel + SocketAdapter
│   │
│   │  ── Core（主入口 + 业务封装） ──
│   ├── core/               ⭐ Core + Hub + CoreCtx + ApiHub + 协议封装
│   │                       —— Hub 在这里（避免 channel↔core 循环）
│   │
│   │  ── Inbound（外部协议消费 CoreCtx） ──
│   ├── onebot/             OneBot v11 (HTTP + WS)
│   ├── websocket/          底层 WS server（被 onebot / webui-backend 共用）
│   ├── webui-backend/      ⭐ Hono server + REST/WS（拆自 webui）
│   ├── webui-frontend/     ⭐ Vite SPA（拆自 webui）
│   └── sdk/                TS SDK
│
├── package.json
└── pnpm-workspace.yaml
```

⭐ 标记的是 v3 改动。

### 1.1 关键变动

| 当前 | 目标 | 备注 |
|---|---|---|
| `@snowluma/bridge`（hook + transport + adapter + manager） | `@snowluma/channel`（仅接口 + abstract Channel）+ `@snowluma/channel-hook`（hook 实现） | 包名 v2 叫 bridge，v3 重命名；hook 全套迁出独立包 |
| `@snowluma/core`（含 Account + AccountManager） | `core`：Core + Hub | Account → Core；AccountManager 折进 Hub |
| —— | `channel-socket` | 新建 stub |
| `@snowluma/webui` | `webui-backend` + `webui-frontend` | 前后端拆分 |

### 1.2 依赖 DAG（无环）

```
common ◄── proton, proto-defs, protocol, runtime, ui, channel
proto-defs ◄── protocol
proton ◄── protocol
protocol ◄── core
channel ◄── channel-hook, channel-socket, core
channel-hook ◄── core
channel-socket ◄── core
core ◄── onebot, webui-backend
websocket ◄── onebot, webui-backend
ui ◄── webui-frontend
```

**核心要点**：`core` 是唯一一处同时知道 `channel` 端口 + 业务实现的地方。Channel 包不反向依赖 core，因此 Hub **住在 core**，而不是 channel —— 名字保留 `Hub` 是因为它语义上仍是「channel 集群的指挥官」。

---

## 2. 三个关键类型 / 接口（设计核心）

整个系统由 **3 个类型** 串起来。每个职责单一、边界清晰。

### 2.1 `Channel`（在 `@snowluma/channel`）—— 纯 transport

```ts
// packages/channel/src/channel.ts
export type ChannelKind = 'inject' | 'socket';

export interface Channel {
  readonly kind: ChannelKind;
  readonly uin: string;
  readonly id: string;                      // adapter:uin 形式

  sendRawPacket(cmd: string, body: Uint8Array): Promise<SendPacketResult>;
  setPacketHandler(h: ((pkt: PacketInfo) => void) | null): void;
  deliverPacket(pkt: PacketInfo): void;     // adapter 内部用
  dispose(): void;
}
```

Adapter 包（`channel-hook` / `channel-socket`）的具体类（`HookChannel` / `SocketChannel`）实现 `Channel`。它们的内部状态（PID set、hook session、socket fd）对外不可见。

### 2.2 `ChannelCtx`（在 `@snowluma/channel`）—— channel → core 的能力 POJO

```ts
// packages/channel/src/channel-ctx.ts
export interface ChannelCtx {
  readonly uin: string;
  readonly kind: ChannelKind;
  readonly sendRawPacket: (cmd: string, body: Uint8Array) => Promise<SendPacketResult>;
  readonly onPacket: (h: (pkt: PacketInfo) => void) => void;
  readonly dispose: () => void;
}

// Hub 用 makeCtx(channel) 把 Channel 投影成 ChannelCtx：
export function makeChannelCtx(b: Channel): ChannelCtx {
  return {
    uin: b.uin, kind: b.kind,
    sendRawPacket: (c, x) => b.sendRawPacket(c, x),
    onPacket: (h) => b.setPacketHandler(h),
    dispose: () => b.dispose(),
  };
}
```

**关键设计**：`Core` 只接收 `ChannelCtx`（capability POJO），**不**持有 `Channel` 类引用。这样 `core` 包不依赖任何 adapter 实现细节，连 Channel 抽象类都不用 import。

### 2.3 `CoreCtx`（在 `@snowluma/core`）—— core → onebot 的能力 POJO

```ts
// packages/core/src/core-ctx.ts
export interface CoreCtx {
  readonly uin: string;
  readonly kind: ChannelKind;
  readonly apis: ApiHub;              // 所有 typed api（message/contacts/...）
  readonly events: EventBus;    // 该账号的事件（per-uin）
  readonly identity: IdentityService; // UID/UIN/group roster
}
```

**关键设计**：OneBot 拿到的就是这个 POJO 投影，**不**持有 `Core` 类引用。Hub 在 `core-online` 事件里把 `CoreCtx` 透出去；OneBot 按 uin 存起来用。

---

## 3. `Hub` —— 主入口完整实现

所有所有权、生命周期、装配都在这里。**外部 main.ts 只跟它打交道。**

```ts
// packages/core/src/hub.ts
import { Channel, ChannelAdapter, ChannelAdapterHost, makeChannelCtx } from '@snowluma/channel';
import { Core } from './core';
import type { CoreCtx } from './core-ctx';
import { TypedEmitter } from '@snowluma/common/typed-emitter';

type Lifecycle = {
  'core-online':  CoreCtx;
  'core-offline': { uin: string };
};

export class Hub {
  private readonly cores = new Map<string, Core>();
  private readonly adapters: ChannelAdapter[] = [];
  readonly events = new TypedEmitter<Lifecycle>();

  registerAdapter(a: ChannelAdapter): void {
    this.adapters.push(a);
  }

  async start(): Promise<void> {
    const host: ChannelAdapterHost = {
      onChannelReady: (b) => this.onChannelReady(b),
      onChannelGone:  (uin) => this.onChannelGone(uin),
    };
    await Promise.all(this.adapters.map((a) => a.start(host)));
  }

  async stop(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop()));
    for (const c of this.cores.values()) c.dispose();
    this.cores.clear();
  }

  // ─── private ───────────────────────────────

  private onChannelReady(channel: Channel): void {
    const stale = this.cores.get(channel.uin);
    if (stale) {
      stale.dispose();
      this.events.emit('core-offline', { uin: channel.uin });
    }
    const core = new Core(makeChannelCtx(channel));
    this.cores.set(channel.uin, core);
    this.events.emit('core-online', core.publicCtx);
  }

  private onChannelGone(uin: string): void {
    const core = this.cores.get(uin);
    if (!core) return;
    core.dispose();
    this.cores.delete(uin);
    this.events.emit('core-offline', { uin });
  }
}
```

## 4. `Core` 实现要点

```ts
// packages/core/src/core.ts
import type { ChannelCtx } from '@snowluma/channel';
import { EventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { buildApiHub, type ApiHub } from './apis';
import type { CoreCtx } from './core-ctx';

export class Core {
  readonly events = new EventBus();   // ← 每账号一个 bus
  readonly identity: IdentityService;
  readonly apis: ApiHub;
  private readonly pipeline: IncomingPacketPipeline;

  constructor(private readonly channelCtx: ChannelCtx) {
    this.identity = IdentityService.openForUin(channelCtx.uin);
    this.pipeline = new IncomingPacketPipeline(this.events, this.identity);
    this.apis = buildApiHub(this);              // apis 内部持 Core 引用，调 sendRawPacket
    channelCtx.onPacket((pkt) => this.pipeline.process(pkt));
  }

  // 给外部消费者的投影（只读 POJO，不暴露 Core 实例）
  get publicCtx(): CoreCtx {
    return {
      uin: this.channelCtx.uin,
      kind: this.channelCtx.kind,
      apis: this.apis,
      events: this.events,
      identity: this.identity,
    };
  }

  // apis 内部通过 core 调发包
  sendRawPacket(cmd: string, body: Uint8Array) {
    return this.channelCtx.sendRawPacket(cmd, body);
  }

  dispose(): void {
    this.channelCtx.dispose();
    this.identity.close();
  }
}
```

## 5. OneBot 消费 `CoreCtx`

```ts
// packages/onebot/src/manager.ts
import type { Hub, CoreCtx } from '@snowluma/core';

export class OneBotManager {
  private readonly byUin = new Map<string, CoreCtx>();

  bind(hub: Hub): void {
    hub.events.on('core-online',  (ctx) => this.attach(ctx));
    hub.events.on('core-offline', ({ uin }) => this.detach(uin));
  }

  private attach(ctx: CoreCtx): void {
    this.byUin.set(ctx.uin, ctx);
    ctx.events.on('group_message',  (e) => this.dispatchGroupMessage(ctx, e));
    ctx.events.on('private_message',(e) => this.dispatchPrivateMessage(ctx, e));
    // ... 其它 kind
  }

  private detach(uin: string): void {
    this.byUin.delete(uin);
    // ctx.events 随 Core dispose 一起释放
  }

  // 处理 OneBot HTTP/WS action：用 uin 查到 ctx，直接调 apis
  async handleSendGroupMsg(uin: string, groupId: number, msg: OneBotMsg) {
    const ctx = this.byUin.get(uin);
    if (!ctx) throw new Error(`unknown uin: ${uin}`);
    return ctx.apis.message.sendGroup(groupId, msg);  // ← 直接调封装好的 api
  }
}
```

## 6. 主入口（`packages/core/src/index.ts`）

```ts
import { HookAdapter } from '@snowluma/channel-hook';
import { OneBotManager } from '@snowluma/onebot';
import { Hub } from './hub';

const hub = new Hub();
hub.registerAdapter(new HookAdapter({ autoLoadOnDiscovery: true }));
// hub.registerAdapter(new SocketAdapter()); // 未来

const onebot = new OneBotManager();
onebot.bind(hub);

await hub.start();
await initWebUI(port, onebot, /* hookManager from adapter */);
```

9 行装配，每行都是有意义的所有权声明。

---

## 7. 为什么这样设计优雅

### 7.1 单向数据流

```
adapter → Channel → ChannelCtx → Core → CoreCtx → OneBot
     transport       capability      capability
```

**没有反向引用**：Core 不知道 Channel 类，OneBot 不知道 Core 类。每层只看到「下一层的能力 POJO」。

### 7.2 单一所有者

`Hub.cores: Map<uin, Core>` 是 **唯一** 持有 Core 的地方。OneBot 只持 `CoreCtx`（投影，不算所有权）。Core 销毁 = 从这个 Map 里删 = 所有 ctx 同时失效。无需引用计数、无需 GC 协调。

### 7.3 每账号独立 EventBus

Core 自带 `events: EventBus`，互不干扰。OneBot 通过 `core-online` 拿到 ctx 后立即 subscribe，`core-offline` 时 Core 已 dispose，bus 自然失效，不会泄漏。**没有全局 bus**，没有「哪个账号的事件」问题。

### 7.4 完全可测

- 测 Channel：mock `setPacketHandler` 回调（已在 `account-private-routing.test.ts` 用 `FakeChannel` 验证）
- 测 Core：传 `ChannelCtx` POJO 即可，无需真 Channel
- 测 OneBot：emit 一个 `core-online` + 假 `CoreCtx`
- 测 Hub：用 fake `ChannelAdapter`

每层都能独立测试。

### 7.5 内部还要避免 ctx 漫天的两个小招

**(a) Api 类捕获 deps（已做）**

```ts
class MessageApi {
  constructor(private readonly core: Core) {}
  // 方法签名只有业务参数：
  async sendGroup(groupId: number, msg: Msg) { this.core.sendRawPacket(...) }
}
```

**(b) AsyncLocalStorage 处理日志 / trace（建议引入）**

```ts
// packages/common/src/async-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage<{ uin?: string; trace?: string }>();

export const runInContext = <T>(c: { uin?: string; trace?: string }, fn: () => T) =>
  als.run(c, fn);
export const ctx = () => als.getStore() ?? {};

// logger 自动 prefix [uin]，业务代码不用接 log 参数
```

在 `Core.constructor` 给 `onPacket` 包一层：
```ts
channelCtx.onPacket((pkt) => {
  runInContext({ uin: channelCtx.uin, trace: `pkt:${pkt.seqId}` }, () => {
    this.pipeline.process(pkt);
  });
});
```

所有下游 `log.info()` 自动带 `[10001]` 前缀，不污染业务签名。开销 ~50ns/call。

---

## 8. 不要的设计（保持简单）

| 方案 | 不做的原因 |
|---|---|
| **`CoreFactory` 抽象** | Core 只一种，多此一举。直接 `new Core(ctx)` |
| **全局 EventBus** | 每账号自己的 bus 更清晰，OneBot 按 uin 订阅，不混杂 |
| **`AccountManager` 独立层** | 多余的中间层，折进 `Hub` |
| **`InboundAdapter` 抽象** | OneBot / WebUI 数量有限且固定，直接 `bm.events.on(...)` 即可，不抽插件层 |
| **DI 容器（tsyringe 等）** | 9 行手动装配已经清晰，DI 引入反射/装饰器元数据反而难调 |
| **Effect monad / Reader monad** | TS 缺 do-notation，类型噪音 > 收益 |
| **CQRS / Event-sourced state** | 当前状态量级（10 账号 × 100 群）远未到 |

---

## 9. 迁移路线（每步独立可 ship）

> typecheck + 全测试通过才进下一步。

**Step 1** —— ⭐ 重命名 + 拆现有的 `@snowluma/bridge`
- `packages/bridge/` 重命名为 `packages/channel/`；package.json name 改为 `@snowluma/channel`
- 新建 `packages/channel-hook/`，从 `@snowluma/channel` 搬：`hook-manager.ts` / `hook-session.ts` / `hook-packet-client.ts` / `injector.ts` / `pipe-watcher.ts` / `qq-hook-client.ts` / `qq-port-probe.ts` / `hook-channel.ts`（原 inject-bridge.ts）/ `hook-adapter.ts`（原 inject-adapter.ts）
- `@snowluma/channel` 留：`channel.ts`（abstract，原 bridge.ts）/ `channel-interface.ts` / `channel-ctx.ts`（新）/ `adapter.ts`（端口）+ `makeChannelCtx` 工具
- 删除：`manager.ts`（原 BridgeManager）（搬到 core/hub.ts）/ `socket-channel.ts` + `socket-adapter.ts`（搬到 `channel-socket` stub）

**Step 2** —— ⭐ 重塑 `@snowluma/core`
- 删除：`account/account.ts` / `account-interface.ts` / `account-context.ts` / `account-manager.ts`
- 新建：`core.ts`（吸收 Account 业务，构造接 `ChannelCtx`）/ `core-ctx.ts` / `hub.ts`
- `apis/` 内部 `AccountContext` → `Core`（直接拿 Core 类型）
- `index.ts` 9 行装配（见 §6）

**Step 3** —— OneBot 适配 CoreCtx
- 全局 `AccountInterface` → `CoreCtx`
- `OneBotManager.bind(hub)` 订阅 `'core-online'` / `'core-offline'`
- 内部 `byUin.get(uin).apis.<area>.method()` 调 api

**Step 4** —— 引入 `AsyncLocalStorage`
- `packages/common/src/async-context.ts`
- `logger.ts` 自动读 ALS，加 `[uin]` 前缀
- `Core.constructor` 在 `onPacket` 回调外包 `runInContext`

**Step 5** —— `channel-socket` stub 包（占位）
- 把 `socket-channel.ts` / `socket-adapter.ts` 搬过来
- 实现 placeholder，让 `ChannelAdapter` 端口齐

**Step 6** —— ⭐ 拆 `webui` 为 `webui-backend` + `webui-frontend`
- Hono server + REST/WS → `webui-backend`，依赖 `@snowluma/core`（消费 `CoreCtx`）
- Vite SPA + UI → `webui-frontend`，依赖 `@snowluma/ui`

---

## 10. 设计原则速查

- **单向数据流**：`adapter → Channel → ChannelCtx → Core → CoreCtx → OneBot`，无反向引用
- **能力 POJO 跨层传递**：层间用 `{ uin, sendRawPacket, ... }` / `{ uin, apis, events, ... }` 这种纯数据，不传类实例
- **单一所有者**：`Hub.cores` 是 Core 唯一容器，消费者只持投影
- **每账号自带 EventBus**：避免全局 bus 混杂，订阅生命周期与 Core 绑定
- **Class 封装 deps**：构造时捕获，方法签名只剩业务参数
- **AsyncLocalStorage 跨切面**：日志 / trace 不进显式参数
- **不引入过度抽象**：no factory / no DI / no Effect monad / no global bus
- **可测**：每层接 POJO，fake 一下就能测

---

## 11. v2.0.0 已完成

- ✅ UID/UIN Service + SQLite 持久化
- ✅ tsx 免打包 Debug
- ✅ Common / OneBot / Core / Bridge / Protocol / proto-defs 拆包
- ✅ 消息 hot-path 优化（17.5μs → 4.7μs，better-sqlite3 + prepared-statement cache）
- ✅ NapCat 风格 Api 层（13 Api 类）
- ✅ Bridge / Account 严格分层（v2 中间形态；v3 重命名为 Channel + Core，并用 ctx 替代直接引用）
- ✅ `@snowluma/bridge` 完整 transport 包（v3 重命名为 `@snowluma/channel`）



