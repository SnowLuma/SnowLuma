import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '../src/protocol/packet-sender';
import { protoDecode, protoEncode } from '../src/protobuf/decode';
import { SendMessageRequestSchema, SendMessageResponseSchema } from '../src/bridge/proto/action';

vi.mock('../src/bridge/element-builder', () => ({
  buildSendElems: vi.fn(async () => [{ text: { str: 'stub media elem' } }]),
}));

describe('Bridge private media routing', () => {
  it('includes resolved uid in the final c2c send request for media messages', async () => {
    const { Bridge } = await import('../src/bridge/bridge');
    const { IdentityService } = await import('../src/bridge/identity-service');

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
          responseData: Buffer.from(protoEncode({
            result: 0,
            privateSequence: 88,
            timestamp1: 1710000000,
          }, SendMessageResponseSchema)),
        };
      }
    }

    const bridge = new TestBridge(IdentityService.memory('10000'));
    await bridge.sendPrivateMessage(12345, [{ type: 'video', url: 'file:///tmp/clip.mp4' } as any]);

    expect(bridge.capturedBody).toBeInstanceOf(Uint8Array);
    const request = protoDecode(bridge.capturedBody as Uint8Array, SendMessageRequestSchema);
    expect(request?.routingHead?.c2c).toMatchObject({
      uin: 12345,
      uid: 'u_peer_12345',
    });
  });
});
