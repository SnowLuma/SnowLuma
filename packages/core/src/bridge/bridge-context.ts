import type { BridgeContext as BaseBridgeContext } from '@snowluma/protocol/bridge-context';
import type { ApiHub } from './apis';

export interface BridgeContext extends BaseBridgeContext {
  readonly apis: ApiHub;
}
export type { UploadedFileMeta } from '@snowluma/protocol/bridge-context';

