import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { RoutingHead, SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2C2CUserInfo, NTV2UploadRichMediaReq, NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/bridge/bridge';

const png = 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=';

function fixture(rejectUpload = false) {
  const requests: Array<{ command: string; body: Uint8Array }> = [];
  class TestBridge extends Bridge {
    override async resolveUserUid(): Promise<string> { return 'u_peer'; }

    override async sendRawPacket(command: string, body: Uint8Array): Promise<SendPacketResult> {
      requests.push({ command, body });
      let response: Uint8Array;
      if (command === 'OidbSvcTrpcTcp.0x11c5_100') {
        response = protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
          command: 0x11c5, subCommand: 100,
          errorCode: rejectUpload ? 170019003 : 0,
          errorMsg: rejectUpload ? 'verify identify fail' : '',
          body: { upload: { msgInfo: { msgInfoBody: [{ index: { fileUuid: 'cached-image' } }] } } },
        });
      } else if (command === 'MessageSvc.PbSendMsg') {
        response = protobuf_encode<SendMessageResponse>({ result: 0, privateSequence: 88 });
      } else {
        throw new Error(`unexpected packet: ${command}`);
      }
      return { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.from(response) };
    }
  }
  return { bridge: new TestBridge(IdentityService.memory('10000')), requests };
}

describe('passive temp-session image wire request (#471)', () => {
  it('uses the same existing-session route for image upload and the final message', async () => {
    const { bridge, requests } = fixture();
    await bridge.apis.message.sendGroupTempMessage(1001, 700, [
      { type: 'text', text: 'reply' },
      { type: 'image', url: png },
    ]);

    expect(requests.map((r) => r.command)).toEqual([
      'OidbSvcTrpcTcp.0x11c5_100', 'MessageSvc.PbSendMsg',
    ]);
    const upload = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(requests[0]!.body).body!;
    expect(upload.reqHead?.scene).toMatchObject({
      sceneType: 1, businessType: 1, c2c: { accountType: 2, targetUid: 'u_peer' },
    });
    expect(upload.reqHead?.scene?.group ?? undefined).toBeUndefined();
    const route = upload.reqHead!.scene!.c2c!.routingHead!;
    expect(Array.from(route)).toEqual([
      0x1a, 0x0b, 0x18, 0xbc, 0x05, 0x22, 0x06, 0x75, 0x5f, 0x70, 0x65, 0x65, 0x72,
    ]);
    expect(Array.from(protobuf_encode<NTV2C2CUserInfo>(upload.reqHead!.scene!.c2c!))).toEqual([
      0x08, 0x02, 0x12, 0x06, 0x75, 0x5f, 0x70, 0x65, 0x65, 0x72,
      0x1a, 0x0d, 0x1a, 0x0b, 0x18, 0xbc, 0x05, 0x22, 0x06, 0x75, 0x5f, 0x70, 0x65, 0x65, 0x72,
    ]);
    const sent = protobuf_decode<SendMessageRequest>(requests[1]!.body);
    expect(protobuf_decode<RoutingHead>(route)).toEqual(sent.routingHead);
    expect(sent.routingHead?.grpTmp).toEqual({ groupUin: 700n, toUid: 'u_peer' });
    expect(sent.messageBody?.richText?.elems).toEqual([
      expect.objectContaining({ text: expect.objectContaining({ str: 'reply' }) }),
      expect.objectContaining({ commonElem: expect.objectContaining({ serviceType: 48, businessType: 10 }) }),
    ]);
  });

  it('keeps normal private image uploads free of temp-session context', async () => {
    const { bridge, requests } = fixture();
    await bridge.apis.message.sendPrivate(1001, [{ type: 'image', url: png }]);
    const upload = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(requests[0]!.body).body!;
    expect(upload.reqHead?.scene?.c2c?.routingHead ?? undefined).toBeUndefined();
    const sent = protobuf_decode<SendMessageRequest>(requests[1]!.body);
    expect(sent.routingHead?.grpTmp ?? undefined).toBeUndefined();
  });

  it('propagates upload rejection without sending text or retrying as another conversation', async () => {
    const { bridge, requests } = fixture(true);
    await expect(bridge.apis.message.sendGroupTempMessage(1001, 700, [
      { type: 'text', text: 'must not be sent separately' },
      { type: 'image', url: png },
    ])).rejects.toThrow('verify identify fail');
    expect(requests.map((r) => r.command)).toEqual(['OidbSvcTrpcTcp.0x11c5_100']);
  });

  it('rejects missing source context before reading the image or sending any packet', async () => {
    const { bridge, requests } = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not download image'));
    try {
      await expect(buildSendElems([{ type: 'image', url: 'https://must-not-fetch.invalid/image.png' }], {
        bridge, scene: 'group-temp', userUid: 'u_peer',
      })).rejects.toThrow('temp-session image source group is missing');
      expect(fetch).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    } finally { fetch.mockRestore(); }
  });
});
