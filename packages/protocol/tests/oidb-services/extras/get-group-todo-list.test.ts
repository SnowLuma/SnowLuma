import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbQueryGroupTopBannersReq } from '@snowluma/proto-defs/oidb-actions/base';

import { GetGroupTodoList } from '../../../src/oidb-services/extras/get-group-todo-list';

// Fixed wire fixture shaped after a live QQ 3.2.32-51802 0x9474_0 response.
// It deliberately uses the current common-banner representation rather than
// constructing the response with the production protobuf encoder.
const ACTIVE_TODO_RESPONSE = Buffer.from(
  '08f4a802100018002291010a8e01080f10021a06353633315f3040d09ba8bb06'
  + 'a2016a0a3f0a1d68747470733a2f2f6578616d706c652e746573742f746f646f'
  + '2e706e67120ce7bea4e5be85e58a9eefbd9c1a0ce6b58be8af95e5be85e58a9e'
  + '28023003121b08031a177b22736571223a353633312c2272616e646f6d223a307d'
  + '18c0ffa7bb0620c1ffa7bb06c802a29c01d002c801e80201f002012a006000',
  'hex',
);

function makeSender(responseData = Buffer.alloc(0)) {
  const result: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData,
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('GetGroupTodoList namespace', () => {
  it('queries 0x9474_0 with the todo-only banner flag', async () => {
    const sender = makeSender();

    await GetGroupTodoList.invoke(sender, { groupId: 941657197 });

    const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x9474_0');
    expect(GetGroupTodoList.subCommand).toBe(0);
    const envelope = protobuf_decode<OidbBase<OidbQueryGroupTopBannersReq>>(bytes);
    expect(envelope).toMatchObject({
      command: 0x9474,
      body: { groupId: 941657197n, bannerFlag: 1 },
    });
  });

  it('decodes the current common-banner todo and validates both identity sources', async () => {
    const sender = makeSender(ACTIVE_TODO_RESPONSE);

    await expect(GetGroupTodoList.invoke(sender, { groupId: 941657197 })).resolves.toEqual([
      {
        sourceId: '5631_0',
        sequence: 5631,
        random: 0,
        text: '测试待办',
        createdAt: 1735000000,
        updatedAt: 1735000001,
      },
    ]);
  });

  it('filters disappeared todo tombstones', () => {
    expect(GetGroupTodoList.deserialize({} as never, {
      banners: [{ bizType: 15, bannerType: 2, isDisappear: true, bizId: 20002 }],
    })).toEqual([]);
  });

  it('supports the legacy todo text shape without inventing timestamps', () => {
    expect(GetGroupTodoList.deserialize({} as never, {
      banners: [{
        msgId: Buffer.from('88_0'),
        isDisappear: false,
        todoBanner: { text: '旧版待办' },
      }],
    })).toEqual([{
      sourceId: '88_0',
      sequence: 88,
      random: 0,
      text: '旧版待办',
      createdAt: 0,
      updatedAt: 0,
    }]);
  });

  it('rejects an active todo whose message identity cannot be mapped', () => {
    expect(() => GetGroupTodoList.deserialize({} as never, {
      banners: [{
        bizType: 15,
        bannerType: 2,
        msgId: Buffer.from('not-a-message-id'),
        isDisappear: false,
        bizId: 20002,
      }],
    })).toThrow(/invalid group todo message identity/);
  });

  it('rejects disagreement between msgId and the jump payload', () => {
    expect(() => GetGroupTodoList.deserialize({} as never, {
      banners: [{
        bizType: 15,
        bannerType: 2,
        msgId: Buffer.from('5631_0'),
        isDisappear: false,
        bizId: 20002,
        commonBanner: {
          jumpInfo: { jumpParam: Buffer.from('{"seq":5632,"random":0}') },
        },
      }],
    })).toThrow(/identity mismatch/);
  });
});
