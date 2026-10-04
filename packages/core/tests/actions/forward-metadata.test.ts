import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SendLongMsgResp } from '@snowluma/proto-defs/longmsg';
import { buildApiContext, type OneBotInstanceContext } from '@snowluma/onebot/instance-context';
import { ForwardApi } from '../../src/bridge/apis/forward';
import { mockBridge } from './_helpers';

vi.mock('@snowluma/protocol/highway/image-upload', () => ({ uploadImageMsgInfo: vi.fn() }));
vi.mock('@snowluma/protocol/highway/ptt-upload', () => ({ uploadPttMsgInfo: vi.fn() }));
vi.mock('@snowluma/protocol/highway/video-upload', () => ({ uploadVideoMsgInfo: vi.fn() }));

describe('forward metadata through upload and cached reads', () => {
  it.each([
    { nested: false, enrich: false }, { nested: true, enrich: false },
    { nested: false, enrich: true }, { nested: true, enrich: true },
  ])('preserves titles and previews with nesting=$nested and enrichment=$enrich', async ({ nested, enrich }) => {
    let uploadCount = 0;
    const sendRawPacket = vi.fn(async () => ({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<SendLongMsgResp>({
        result: { resId: `metadata-${nested}-${enrich}-${++uploadCount}` },
      })),
    }));
    const bridge = mockBridge({ sendRawPacket });
    bridge.apis.contacts.fetchGroupMemberList.mockResolvedValue([
      { uin: 111, nickname: 'resolved outer', card: '' },
    ]);
    const forward = new ForwardApi(bridge as any);
    const ctx = {
      selfId: 10001,
      bridge: { apis: {
        forward,
        message: { sendGroup: vi.fn(async () => ({
          messageId: 1, sequence: 2, clientSequence: 0, random: 3, timestamp: 1700000000,
        })) },
      } },
      messageStore: { findEvent: () => null, findMedia: () => null },
      cacheMessageMeta: vi.fn(),
      converterCtx: {
        selfId: 10001, imageUrlResolver: null, mediaUrlResolver: null,
        messageIdResolver: null, mediaSegmentSink: null,
      },
    } as unknown as OneBotInstanceContext;
    const api = buildApiContext(ctx);
    const text = [{ type: 'text', data: { text: 'hello' } }];
    const preview = {
      title: 'outer title', source: 'custom source', summary: 'custom summary',
      prompt: 'custom prompt', news: [{ text: 'custom preview' }],
    };
    const { forwardId } = await api.sendGroupForwardMsg(12345, [{
      type: 'node', data: {
        user_id: 111, nickname: enrich ? '' : 'outer', ...preview,
        content: nested
          ? [{ type: 'node', data: { user_id: 222, nickname: 'inner', title: 'inner title', content: text } }]
          : text,
      },
    }]);

    const first = await api.getForwardMsg(forwardId);
    expect(first[0]!.sender).toMatchObject({ title: 'outer title' });
    expect(first[0]!.sender).toMatchObject({ nickname: enrich ? 'resolved outer' : 'outer' });
    expect((await forward.fetch(forwardId!))[0]).toMatchObject(preview);
    if (nested) {
      expect((await api.getForwardMsg(`metadata-true-${enrich}-1`))[0]!.sender)
        .toMatchObject({ title: 'inner title' });
    }

    const fetched = await forward.fetch(forwardId!);
    fetched[0]!.title = 'changed title';
    fetched[0]!.news![0]!.text = 'changed preview';
    preview.news[0]!.text = 'changed input';
    const again = await forward.fetch(forwardId!);
    expect(again[0]!.title).toBe('outer title');
    expect(again[0]!.news).toEqual([{ text: 'custom preview' }]);
    expect(sendRawPacket).toHaveBeenCalledTimes(nested ? 2 : 1);
  });
});
