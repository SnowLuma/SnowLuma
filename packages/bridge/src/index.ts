// Public entry — re-exports the hook orchestration surface that the
// top-level app (and webui readers) consume. Everything else is
// internal to the package.

export {
  HookManager,
  type HookManagerDeps,
  type BridgeManagerSink,
  type HookProcessInfo,
  type HookProcessStatus,
  type HookProcessBaseInfo,
  type QqPortLoginInfo,
} from './hook-manager';
