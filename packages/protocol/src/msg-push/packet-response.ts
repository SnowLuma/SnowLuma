import type { SendPacketResult } from '@snowluma/common/packet-sender';

export function requirePacketResponse(
  result: SendPacketResult,
  command: string,
): Uint8Array {
  if (!result.success) {
    throw new Error(
      `${command} transport failed: ${result.errorMessage || 'unknown transport error'}`,
    );
  }
  if (!result.gotResponse || !result.responseData || result.responseData.length === 0) {
    throw new Error(`${command} response is empty`);
  }
  return result.responseData;
}
