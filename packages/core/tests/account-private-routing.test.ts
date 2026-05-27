import type { BridgeInterface } from '@snowluma/bridge';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import type { FileExtra } from '@snowluma/proto-defs/message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { Account } from '../src/account/account';

vi.mock('@snowluma/protocol/element-builder', () => ({
  buildSendElems: vi.fn(async () => [{ text: { str: 'stub media elem' } }]),
}));

/**
 * Thin fake transport — implements `BridgeInterface` directly without
 * inheriting from `Bridge`, so each test gets a clean slate plus a
 * single capture slot for the outbound body. The `Account` under test
 * proxies `sendRawPacket` straight through.
 */
class FakeBridge implements BridgeInterface {
  readonly kind = 'inject' as const;
  readonly id = 'inject:test';
  capturedBody: Uint8Array | null = null;
  private response_: SendPacketResult = {
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

  constructor(public readonly uin: string) { }

  setResponse(resp: SendPacketResult): void { this.response_ = resp; }

  async sendRawPacket(_cmd: string, body: Uint8Array): Promise<SendPacketResult> {
    this.capturedBody = body;
    return this.response_;
  }

  setPacketHandler(_handler: ((pkt: PacketInfo) => void) | null): void { /* unused */ }
  deliverPacket(_pkt: PacketInfo): void { /* unused */ }
  dispose(): void { /* unused */ }
}

describe('Account private media routing', () => {
  it('includes resolved uid in the final c2c send request for media messages', async () => {
    const { IdentityService } = await import('@snowluma/protocol/identity-service');

    const bridge = new FakeBridge('10000');
    bridge.setResponse({
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
    });

    const account = new Account(bridge, IdentityService.memory('10000'));
    // resolveUserUid lookup needs an explicit override since the
    // identity store has no mapping for the test peer.
    account.resolveUserUid = vi.fn(async (uin: number) => {
      expect(uin).toBe(12345);
      return 'u_peer_12345';
    });

    await account.apis.message.sendPrivate(12345, [{ type: 'video', url: 'file:///tmp/clip.mp4' } as any]);

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
    const { IdentityService } = await import('@snowluma/protocol/identity-service');

    const bridge = new FakeBridge('10000');
    const account = new Account(bridge, IdentityService.memory('10000'));

    const fileMd5 = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await account.apis.message.sendC2cFile(67890, 'u_peer_xyz', {
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
    });
    expect(fileExtra?.file?.fileMd5).toEqual(fileMd5);
    // expireTime is now+7d; just sanity-check it landed (non-zero, plausible)
    expect(fileExtra?.file?.expireTime).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // c2cCmd is left at 0 / undefined — the old `c2cCmd=11` was a
    // stale go-cqhttp value the QQ-NT server doesn't recognise on the
    // c2c-file path.
    expect(request?.contentHead?.c2cCmd ?? 0).toBe(0);
  });
});
