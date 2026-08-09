import type { OnlineDeviceInfo } from '@snowluma/protocol/events';
import type { BridgeContext } from './bridge-context';

export interface BridgeInterface extends BridgeContext {
  readonly activePid: number | null;
  /** False only when every attached QQ process has a confirmed receive or
   *  request-path failure. An unarmed watchdog remains true for compatibility. */
  readonly receiveHealthy: boolean;
  /** Latest device snapshot observed on this Bridge lifecycle. `null` means
   *  QQ has not emitted its cache notification since SnowLuma attached. */
  getOnlineClients(): readonly Readonly<OnlineDeviceInfo>[] | null;
}
