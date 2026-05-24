import type { BridgeContext } from './bridge-context';

export interface BridgeInterface extends BridgeContext {
  readonly activePid: number | null;
}
