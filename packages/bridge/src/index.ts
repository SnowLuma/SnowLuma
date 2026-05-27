// ─── Hook runtime (existing) ───────────────────────────────────────
export {
  HookManager, type BridgeManagerSink, type HookManagerDeps, type HookProcessBaseInfo, type HookProcessInfo,
  type HookProcessStatus, type QqPortLoginInfo
} from './hook-manager';

// ─── Transport layer (Bridge + concrete InjectBridge / ProtocolBridge) ──
export { Bridge } from './bridge';
export { type BridgeInterface, type BridgeKind } from './bridge-interface';
export { InjectBridge } from './inject-bridge';
export { ProtocolBridge } from './protocol-bridge';

// ─── Adapter pattern ───────────────────────────────────────────────
export { type BridgeAdapter, type BridgeAdapterHost } from './adapter';
export { InjectBridgeAdapter, type InjectBridgeAdapterOptions } from './inject-adapter';
export { ProtocolBridgeAdapter } from './protocol-adapter';

// ─── Multi-account host ────────────────────────────────────────────
export {
  BridgeManager, type SessionClosedCallback, type SessionStartedCallback
} from './manager';

