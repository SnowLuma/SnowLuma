import { positiveIntEnv } from '@snowluma/common/env';

/** Default wait for a QQ reply when the caller does not pass one. */
export const DEFAULT_PACKET_TIMEOUT_MS = 15_000;

export function packetTimeoutMs(env?: NodeJS.ProcessEnv): number {
  return positiveIntEnv('SNOWLUMA_PACKET_TIMEOUT_MS', DEFAULT_PACKET_TIMEOUT_MS, { env });
}
