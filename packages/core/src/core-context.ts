import type { BridgeContext as ProtocolBridgeContext } from '@snowluma/protocol/bridge-context';
import type { ApiHub } from './apis';

/**
 * `CoreContext` — the internal context that Api wrappers (`apis/*`)
 * consume. Only used inside `@snowluma/core`; OneBot and other inbound
 * adapters consume the narrower `CoreCtx` projection instead.
 *
 * It extends the protocol-layer `BridgeContext` with one extra slot:
 * `apis: ApiHub`. The protocol layer can't mention `ApiHub` because
 * the apis live in @snowluma/core, so the shared surface is layered:
 *
 *   - `@snowluma/protocol/bridge-context.BridgeContext` — identity,
 *     events, raw packet I/O, sequences, file cache. Consumed by
 *     `element-builder`, highway uploaders, msg-push decoders.
 *   - `@snowluma/core/core-context.CoreContext` — adds `apis`.
 *     Consumed by everything inside `apis/*` and by tests that
 *     stub the surface for OneBot-side unit tests.
 *
 * The concrete `Core` class implements this extended interface.
 */
export interface CoreContext extends ProtocolBridgeContext {
  readonly apis: ApiHub;
}

export type { UploadedFileMeta } from '@snowluma/protocol/bridge-context';
