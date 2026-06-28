import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import type { FileExtra } from '@snowluma/proto-defs/message';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbOfflineFileFinalizeResp } from '@snowluma/proto-defs/oidb-actions/media';

vi.mock('@snowluma/protocol/element-builder', () => ({
  buildSendElems: vi.fn(async () => [{ text: { str: 'stub media elem' } }]),
}));

describe('Bridge private media routing', () => {
  it('includes resolved uid in the final c2c send request for media messages', async () => {
    const { Bridge } = await import('../src/bridge/bridge');
    const { IdentityService } = await import('@snowluma/protocol/identity-service');

    class TestBridge extends Bridge {
      capturedBody: Uint8Array | null = null;

      override async resolveUserUid(uin: number): Promise<string> {
        expect(uin).toBe(12345);
        return 'u_peer_12345';
      }

      override async sendRawPacket(serviceCmd: string, body: Uint8Array): Promise<SendPacketResult> {
        expect(serviceCmd).toBe('MessageSvc.PbSendMsg');
        this.capturedBody = body;
        return {
          success: true,
          gotResponse: true,
          errorCode: 0,
          errorMessage: '',
          responseData: Buffer.from(protobuf_encode<SendMessageResponse>({
            result: 0,
            errMsg: '',
            privateSequence: 88,
            timestamp1: 1710000000,
          })),
        };
      }
    }

    const bridge = new TestBridge(IdentityService.memory('10000'));
    await bridge.apis.message.sendPrivate(12345, [{ type: 'video', url: 'file:///tmp/clip.mp4' } as any]);

    expect(bridge.capturedBody).toBeInstanceOf(Uint8Array);
    const request = protobuf_decode<SendMessageRequest>(bridge.capturedBody as Uint8Array);
    expect(request?.routingHead?.c2c).toMatchObject({
      uin: 12345,
      uid: 'u_peer_12345',
    });
  });

  it('sendC2cFileMessage uses trans0x211 routing + msgContent FileExtra (NOT richText.notOnlineFile)', async () => {
    // Regression: c2c file messages route through `trans0x211 { ccCmd:
    // 4, uid }` (RoutingHead field 15), not `c2c { uin, uid }`. The
    // file metadata lives in `MessageBody.msgContent` (a serialised
    // `FileExtra { file: NotOnlineFile }`), not in `richText.notOnlineFile`.
    // Confirmed against `dev/Lagrange.Core/.../MessagePacker.cs:
    // BuildPacketBase` + `FileEntity.PackMessageContent`. Previous
    // implementation wrote c2c routing + richText.notOnlineFile +
    // c2cCmd=11 — the QQ-NT server rejected every c2c file send.
    const { Bridge } = await import('../src/bridge/bridge');
    const { IdentityService } = await import('@snowluma/protocol/identity-service');

    class TestBridge extends Bridge {
      capturedBody: Uint8Array | null = null;
      finalizeCmd: string | null = null;

      override async resolveUserUid(uin: number): Promise<string> {
        return uin === 10000 ? 'u_self' : `u_${uin}`;
      }

      override async sendRawPacket(cmd: string, body: Uint8Array): Promise<SendPacketResult> {
        // The c2c file send first runs the 0xE37_800 finalize, then PbSendMsg.
        if (cmd.includes('0xe37_800')) {
          this.finalizeCmd = cmd;
          return {
            success: true, gotResponse: true, errorCode: 0, errorMessage: '',
            responseData: Buffer.from(protobuf_encode<OidbBase<OidbOfflineFileFinalizeResp>>({
              body: { body: { metadata: { field3: 11, field100: new Uint8Array([1]), field101: new Uint8Array([2]), field110: 22, timestamp1: 1710000123 } } },
            })),
          };
        }
        this.capturedBody = body;
        return {
          success: true, gotResponse: true, errorCode: 0, errorMessage: '',
          responseData: Buffer.from(protobuf_encode<SendMessageResponse>({
            result: 0, errMsg: '', privateSequence: 88, timestamp1: 1710000000,
          })),
        };
      }
    }
    const bridge = new TestBridge(IdentityService.memory('10000'));

    const fileMd5 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await bridge.apis.message.sendC2cFile(67890, 'u_peer_xyz', {
      fileId: 'uuid-abc-123',
      fileName: 'doc.txt',
      fileSize: 1024,
      fileMd5,
      fileHash: 'hash-xyz',
    });

    const request = protobuf_decode<SendMessageRequest>(bridge.capturedBody as Uint8Array);

    // Routing: must be trans0x211 with ccCmd=4 + uid, no c2c slot.
    expect(request?.routingHead?.trans0x211).toMatchObject({
      ccCmd: 4,
      uid: 'u_peer_xyz',
    });
    expect(request?.routingHead?.c2c ?? undefined).toBeUndefined();

    // Body: msgContent carries the FileExtra; richText is absent (no
    // elems, no notOnlineFile slot — both lived on the wrong place).
    expect(request?.messageBody?.msgContent).toBeInstanceOf(Uint8Array);
    expect(request?.messageBody?.richText ?? undefined).toBeUndefined();

    // Decode the msgContent and verify the NotOnlineFile fields land
    // at the correct tags (Lagrange's NotOnlineFile schema, not the
    // dead FileExtraInfo one).
    const fileExtra = protobuf_decode<FileExtra>(request!.messageBody!.msgContent as Uint8Array);
    expect(fileExtra?.file).toMatchObject({
      fileUuid: 'uuid-abc-123',
      fileName: 'doc.txt',
      fileSize: 1024n,
      fileHash: 'hash-xyz',
      subcmd: 1,      // server-required intake validator field
      // dangerEvel and fileType are 0 — proto3 omits zero values on
      // the wire, so they're not asserted here (matches Lagrange's
      // behaviour: it sets `DangerEvel = 0` but protobuf-net also
      // skips serialising default ints).
    });
    expect(fileExtra?.file?.fileMd5).toEqual(fileMd5);
    // expireTime is now+7d; just sanity-check it landed (non-zero, plausible)
    expect(fileExtra?.file?.expireTime).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // issue #157: the finalize (0xE37_800) must run, and its download routing
    // must ride along in field6 — without it the recipient can't download.
    expect(bridge.finalizeCmd).toBe('OidbSvcTrpcTcp.0xe37_800');
    expect(fileExtra?.field6?.field2).toMatchObject({
      fileUuid: 'uuid-abc-123',
      fileName: 'doc.txt',
      fileHash: 'hash-xyz',
      selfUid: 'u_self',
      destUid: 'u_peer_xyz',
      field1: 22,         // ← finalize metadata.field110
      field6: 11,         // ← finalize metadata.field3
      timestamp1: 1710000123,
    });
    expect(fileExtra?.field6?.field2?.field7).toEqual(new Uint8Array([2]));  // ← metadata.field101
    expect(fileExtra?.field6?.field2?.field8).toEqual(new Uint8Array([1]));  // ← metadata.field100

    // c2cCmd is left at 0 / undefined — the old `c2cCmd=11` was a
    // stale go-cqhttp value the QQ-NT server doesn't recognise on the
    // c2c-file path.
    expect(request?.contentHead?.c2cCmd ?? 0).toBe(0);
  });
});
