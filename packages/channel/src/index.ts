// `@snowluma/channel` — the abstract transport layer + capability POJO
// + adapter port. Concrete transports (HookChannel / SocketChannel)
// and their adapters live in dedicated packages
// (`@snowluma/channel-hook`, `@snowluma/channel-socket`); the
// multi-account host lives in `@snowluma/core` as `Hub`. Nothing in
// this package depends on a runtime — it's pure interfaces and the
// `Channel` abstract base.

// ─── Transport abstract base ───────────────────────────────────────
export { Channel } from './channel';
export { type ChannelInterface, type ChannelKind } from './channel-interface';

// ─── Capability POJO (handed to Core in @snowluma/core) ────────────
export { makeChannelCtx, type ChannelCtx } from './channel-ctx';

// ─── Adapter port ──────────────────────────────────────────────────
export { type ChannelAdapter, type ChannelAdapterHost } from './adapter';
