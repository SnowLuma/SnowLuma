import type { Logger } from '@snowluma/common/logger';
import type { Channel } from './channel';
import type { ChannelKind } from './channel-interface';

export interface ChannelAdapterHost {
  addChannel(channel: Channel): void;
  removeChannel(channelId: string): void;
  readonly log: Logger;
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  start(host: ChannelAdapterHost): Promise<void> | void;
  dispose(): Promise<void> | void;
}
