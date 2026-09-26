import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { Elem } from '@snowluma/proto-defs/element';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import type { MessageElement } from '@snowluma/protocol/events';
import type { OneBotInstanceContext } from '../src/instance-context';
import type { JsonValue } from '../src/types';
import { sendGroupMessage, sendPrivateMessage } from '../src/modules/message-actions';

const sender = 20002;
const target = 30003;
const time = 1700000000;
const sequence = 42;

async function sendQuote(isGroup: boolean, original: JsonValue | null) {
  const packets: Partial<Elem>[] = [];
  const send = vi.fn(async (_target: number, elements: MessageElement[]) => {
    const encoded = await buildSendElems(elements, { bridge: {} as never, groupId: isGroup ? target : undefined });
    for (const element of encoded) {
      packets.push(protobuf_decode<Elem>(protobuf_encode<Elem>(element)));
    }
    return { messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: time + 1 };
  });
  const ref = {
    uin: '10001', selfId: 10001,
    bridge: { apis: { message: { sendGroup: send, sendPrivate: send } } },
    messageStore: {
      findEvent: () => original === null ? null : { user_id: sender, time, message: original },
      findMeta: () => ({ isGroup, targetId: target, timestamp: time, random: 7, sequenceAuthoritative: true }),
      resolveReplySequence: () => sequence,
    },
    cacheMessageMeta: vi.fn(), mediaStore: {}, musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
  await (isGroup ? sendGroupMessage : sendPrivateMessage)(ref, target, [
    { type: 'reply', data: { id: '-12345' } },
    { type: 'text', data: { text: 'answer' } },
  ], false);
  expect(send).toHaveBeenCalledOnce();
  expect(packets.find(p => p.text)?.text?.str).toBe('answer');
  return packets.find(p => p.srcMsg)?.srcMsg;
}

function preview(src: Partial<Elem>['srcMsg']) {
  return src?.elemsRaw?.map(raw => protobuf_decode<Elem>(raw).text?.str).join('');
}

describe.each([true, false])('outbound quote preview (group=%s)', (isGroup) => {
  it('carries cached Unicode text through OneBot parsing and wire encoding', async () => {
    const src = await sendQuote(isGroup, [
      { type: 'text', data: { text: '第一段\n' } },
      { type: 'text', data: { text: '第二段😀' } },
    ]);
    expect(src?.origSeqs).toEqual([sequence]);
    expect(src?.senderUin).toBe(BigInt(sender));
    expect(src?.time).toBe(time);
    expect(preview(src)).toBe('第一段\n第二段😀');
  });

  it('previews media without uploading it or recursively quoting earlier replies', async () => {
    const src = await sendQuote(isGroup, [
      { type: 'reply', data: { id: '99' } },
      { type: 'image', data: { file: 'unavailable.png' } },
      { type: 'record', data: { file: 'unavailable.mp3' } },
      { type: 'text', data: { text: '说明' } },
    ]);
    expect(preview(src)).toBe('[图片][语音]说明');
  });

  it('does not invent content when only message metadata is cached', async () => {
    const src = await sendQuote(isGroup, null);
    expect(src?.origSeqs).toEqual([sequence]);
    expect(src?.senderUin).toBe(10001n);
    expect(src?.elemsRaw?.length ?? 0).toBe(0);
  });
});
