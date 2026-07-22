import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import type { PokeExtra } from '@snowluma/proto-defs/element';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/bridge/bridge';

describe('private window shake wire request', () => {
  it('routes poke type 1 through direct C2C with the verified CommonElem payload', async () => {
    class TestBridge extends Bridge {
      capturedBody: Uint8Array | null = null;

      override async resolveUserUid(): Promise<string> {
        throw new Error('window shake must not resolve media identity');
      }

      override async sendRawPacket(command: string, body: Uint8Array): Promise<SendPacketResult> {
        expect(command).toBe('MessageSvc.PbSendMsg');
        this.capturedBody = body;
        return {
          success: true,
          gotResponse: true,
          errorCode: 0,
          errorMessage: '',
          responseData: Buffer.from(protobuf_encode<SendMessageResponse>({
            result: 0,
            privateSequence: 88,
            timestamp1: 1_710_000_000,
          })),
        };
      }
    }

    const bridge = new TestBridge(IdentityService.memory('10000'));
    await bridge.apis.message.sendPrivate(1787882683, [{ type: 'poke', subType: 1 }]);

    expect(bridge.capturedBody).toBeInstanceOf(Uint8Array);
    const request = protobuf_decode<SendMessageRequest>(bridge.capturedBody!);
    expect(request.routingHead?.c2c).toMatchObject({ uin: 1787882683 });
    expect(request.routingHead?.grp ?? undefined).toBeUndefined();
    expect(request.routingHead?.grpTmp ?? undefined).toBeUndefined();
    expect(request.contentHead).toMatchObject({ type: 1, c2cCmd: 11 });
    expect(request.contentHead?.subType ?? 0).toBe(0);

    const elems = request.messageBody?.richText?.elems ?? [];
    expect(elems).toHaveLength(1);
    expect(elems[0]?.commonElem).toMatchObject({ serviceType: 2, businessType: 1 });
    const payload = elems[0]?.commonElem?.pbElem;
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload!)).toEqual([0x08, 0x01]);
    expect(protobuf_decode<PokeExtra>(payload!)).toEqual({ type: 1 });
  });

  it('rejects mixed direct-private content before resolving media identity', async () => {
    const bridge = new Bridge(IdentityService.memory('10000'));
    const resolveUserUid = vi.spyOn(bridge, 'resolveUserUid').mockResolvedValue('u_peer');

    await expect(bridge.apis.message.sendPrivate(1787882683, [
      { type: 'image', url: 'file:///tmp/must-not-resolve.png' },
      { type: 'poke', subType: 1 },
    ])).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
    });

    expect(resolveUserUid).not.toHaveBeenCalled();
  });

  it('rejects temp-session window shakes before resolving the peer UID', async () => {
    const bridge = new Bridge(IdentityService.memory('10000'));
    const resolveUserUid = vi.spyOn(bridge, 'resolveUserUid').mockResolvedValue('u_peer');

    await expect(bridge.apis.message.sendGroupTempMessage(
      1787882683,
      941657197,
      [{ type: 'poke', subType: 1 }],
    )).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
    });

    expect(resolveUserUid).not.toHaveBeenCalled();
  });
});
