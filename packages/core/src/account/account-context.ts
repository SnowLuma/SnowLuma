import type { BridgeContext as ProtocolBridgeContext } from '@snowluma/protocol/bridge-context';
import type { ApiHub } from './apis';

/**
 * `AccountContext` — the **account-layer** context that Api wrappers
 * (`apis/*`) consume.
 *
 * It extends the protocol-layer `BridgeContext` with one extra slot:
 * `apis: ApiHub`. The protocol layer can't mention `ApiHub` because
 * the apis live in @snowluma/core, so the shared surface is layered:
 *
 *   - `@snowluma/protocol/bridge-context.BridgeContext` — identity,
 *     events, raw packet I/O, sequences, file cache. Consumed by
 *     `element-builder`, highway uploaders, msg-push decoders.
 *   - `@snowluma/core/account/account-context.AccountContext` — adds
 *     `apis`. Consumed by everything inside `apis/*` and by tests that
 *     stub the surface for OneBot-side unit tests.
 *
 * The concrete `Account` class implements this extended interface.
 */
export interface AccountContext extends ProtocolBridgeContext {
  readonly apis: ApiHub;
}

export type { UploadedFileMeta } from '@snowluma/protocol/bridge-context';
