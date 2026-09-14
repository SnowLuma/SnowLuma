import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';
import { OidbError } from '../../../src/oidb-service';
import { Ntv2UploadRequest } from '../../../src/oidb-services/highway/ntv2-upload-request';

function packet(body: NTV2UploadRichMediaResp, errorCode = 0): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
      command: 0x11C5,
      subCommand: 100,
      errorCode,
      errorMsg: errorCode ? 'denied' : '',
      body,
    })),
  };
}

const params: Ntv2UploadRequest.Params = {
  oidbCmd: 0x11C5,
  isGroup: false,
  targetIdOrUid: 'u_peer',
  requestId: 1,
  businessType: 1,
  uploadInfo: [],
  compatQmsgSceneType: 1,
  extBizInfo: {},
  tryFast: true,
  clientRandomId: 1n,
};

describe('Ntv2UploadRequest', () => {
  it('sends the resolved command on the default OIDB wire name', async () => {
    const sendRawPacket = vi.fn(async () => packet({
      upload: { msgInfo: { msgInfoBody: [] } },
    }));
    await Ntv2UploadRequest.invoke({ sendRawPacket }, params);
    expect(sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x11c5_100');
  });

  it('raises OidbError when the envelope is rejected', async () => {
    const sendRawPacket = vi.fn(async () => packet({ upload: { msgInfo: {} } }, 42));
    await expect(Ntv2UploadRequest.invoke({ sendRawPacket }, params)).rejects.toBeInstanceOf(OidbError);
  });

  it('fails in deserialize when msgInfo is missing', async () => {
    const sendRawPacket = vi.fn(async () => packet({ upload: { uKey: 'k' } }));
    await expect(Ntv2UploadRequest.invoke({ sendRawPacket }, params))
      .rejects.toThrow('upload response missing msgInfo');
  });
});
