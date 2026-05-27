// `@snowluma/channel-hook` — the `inject` channel implementation
// (NTQQ in-process hook). Registered with `Hub` from `@snowluma/core`
// as a `ChannelAdapter` of kind `'inject'`. Everything pid-related is
// scoped to this package — neither `@snowluma/channel` nor anything
// downstream knows about it.

// ─── Hook runtime ──────────────────────────────────────────────────
export {
  HookManager, type HookSink, type HookManagerDeps, type HookProcessBaseInfo, type HookProcessInfo,
  type HookProcessStatus, type QqPortLoginInfo
} from './hook-manager';

// ─── Concrete Channel + Adapter ────────────────────────────────────
export { HookChannel } from './hook-channel';
export { HookAdapter, type HookAdapterOptions } from './hook-adapter';
