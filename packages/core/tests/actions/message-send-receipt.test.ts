import { describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from '../../src/bridge/bridge-context';
import { MessageApi } from '../../src/bridge/apis/message';
import { mockBridge } from './_helpers';

function sender(responseHex: string) {
  const ctx = {
    ...mockBridge(),
    nextMessageRandom: () => 1234,
    sendRawPacket: vi.fn(async () => ({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(responseHex, 'hex'),
    })),
  };
  return { api: new MessageApi(ctx as unknown as BridgeContext), send: ctx.sendRawPacket };
}

describe('group send receipts (#492)', () => {
  it('accepts the confirmed response from the issue log', async () => {
    const { api } = sender('080018abb3e8d506500058844a60abb3e8d506700078df0d');
    await expect(api.sendGroup(10001, [{ type: 'text', text: 'test' }])).resolves.toMatchObject({
      sequence: 9476, messageId: 1234,
    });
  });

  it.each([
    ['missing', '080018c9b3e8d506500060c9b3e8d5067000'],
    ['zero', '08005800'],
  ])('rejects a %s receipt without automatically resending', async (_name, response) => {
    const { api, send } = sender(response);
    await expect(api.sendGroup(10001, [{ type: 'text', text: 'test' }]))
      .rejects.toThrow('group message delivery was not confirmed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves an explicit server rejection', async () => {
    const { api } = sender('0801');
    await expect(api.sendGroup(10001, [{ type: 'text', text: 'test' }]))
      .rejects.toThrow('send group message rejected: result=1');
  });
});
