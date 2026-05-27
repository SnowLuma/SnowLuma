// ─── Hook runtime ──────────────────────────────────────────────────
export {
  HookManager, type HookManagerDeps, type HookProcessBaseInfo, type HookProcessInfo,
  type HookProcessStatus, type HookSink, type QqPortLoginInfo
} from './hook-manager';

// ─── Transport layer (abstract Channel + concrete HookChannel / SocketChannel) ──
export { Channel } from './channel';
export { type ChannelInterface, type ChannelKind } from './channel-interface';
export { HookChannel } from './hook-channel';
export { SocketChannel } from './socket-channel';

// ─── Channel capability POJO (handed to Core in @snowluma/core) ────
export { makeChannelCtx, type ChannelCtx } from './channel-ctx';

// ─── Adapter pattern ───────────────────────────────────────────────
export { type ChannelAdapter, type ChannelAdapterHost } from './adapter';
export { HookAdapter, type HookAdapterOptions } from './hook-adapter';
export { SocketAdapter } from './socket-adapter';

// ─── Multi-account host (v3 intermediate; folds into Hub later) ────
export {
  ChannelManager, type SessionClosedCallback, type SessionStartedCallback
} from './manager';

