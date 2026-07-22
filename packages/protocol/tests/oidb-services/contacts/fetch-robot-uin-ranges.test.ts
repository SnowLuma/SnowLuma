import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbRobotUinRangeRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchRobotUinRanges } from '../../../src/oidb-services/contacts/fetch-robot-uin-ranges';

// Captured from QQ's 0x496_0 response and reduced to the versioned range
// config. Keeping this as wire bytes makes the test independent of the
// encoder used by the implementation.
const RESPONSE_FIXTURE = Buffer.from(
  '0896091000180022492a4708ce01120c08fee8fdb20c10fee8fdb20c'
  + '120c08cda8fed00a10cfc5ffd00a120a08c0f8e01f10c0f8e01f12'
  + '0c08c0dcb5be0e10ffe0f2be0e120c0880fd8ef80e10ffa9f1fc0e',
  'hex',
);

function makeSender(responseData = RESPONSE_FIXTURE) {
  const result: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData,
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('FetchRobotUinRanges namespace', () => {
  it('routes the read-only request to 0x496_0 with QQ-compatible fields', async () => {
    const sender = makeSender();

    await FetchRobotUinRanges.invoke(sender);

    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
    const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x496_0');
    const request = protobuf_decode<OidbBase<OidbRobotUinRangeRequest>>(bytes);
    expect(request.body).toEqual({
      justFetchMsgConfig: 1,
      type: 1,
      version: 0,
      aioKeywordVersion: 0,
    });
  });

  it('decodes the server version and every inclusive UIN range', async () => {
    const sender = makeSender();

    await expect(FetchRobotUinRanges.invoke(sender)).resolves.toEqual({
      version: 206,
      ranges: [
        { minUin: 3328144510, maxUin: 3328144510 },
        { minUin: 2854196301, maxUin: 2854216399 },
        { minUin: 66600000, maxUin: 66600000 },
        { minUin: 3889000000, maxUin: 3889999999 },
        { minUin: 4010000000, maxUin: 4019999999 },
      ],
    });
  });

  it('rejects a successful envelope that omits the robot range config', async () => {
    const sender = makeSender(Buffer.from('089609100018002200', 'hex'));

    await expect(FetchRobotUinRanges.invoke(sender))
      .rejects.toThrow('0x496_0 response missing robot range config');
  });

  it('rejects a robot config without its version', () => {
    expect(() => FetchRobotUinRanges.deserialize(makeSender(), {
      robotConfig: {
        ranges: [{ minUin: 3_889_000_000n, maxUin: 3_889_999_999n }],
      },
    })).toThrow('0x496_0 response missing robot range config version');
  });

  it('rejects an empty range set instead of classifying everyone as human', () => {
    expect(() => FetchRobotUinRanges.deserialize(makeSender(), {
      robotConfig: { version: 206, ranges: [] },
    })).toThrow('0x496_0 response has no robot UIN ranges');
  });
});
