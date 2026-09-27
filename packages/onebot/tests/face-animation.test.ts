import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeRichBody } from '@snowluma/protocol/msg-push/rich-body-decoder';
import { convertEvent, type ConverterContext } from '../src/event-converter';
import { MessageStore } from '../src/message-store';
import { GROUP_MESSAGE_EVENT } from '../src/message-id';
import { parseMessage } from '../src/message-parser';
import { getGroupMsgHistory } from '../src/modules/message-actions';
import { segmentsToRawMessage } from '../src/helper/cq';

const ctx: ConverterContext = {
  selfId: 10001,
  imageUrlResolver: null,
  mediaUrlResolver: null,
  messageIdResolver: null,
  mediaSegmentSink: null,
};

describe('face animation results', () => {
  it('preserves zero from an incoming message through CQ, persistence and history', async () => {
    const elements = decodeRichBody({
      richText: { elems: [{ commonElem: {
        serviceType: 37,
        businessType: 2,
        pbElem: Buffer.from('1872320130', 'hex'),
      } }] },
    }, true);
    expect(elements).toEqual([{ type: 'face', faceId: 114, resultId: '0' }]);

    const event = await convertEvent(ctx, {
      kind: 'group_message',
      groupId: 30001,
      groupName: 'group',
      senderUin: 20001,
      senderNick: 'sender',
      senderCard: '',
      senderRole: 'member',
      selfUin: 10001,
      time: 1_700_000_000,
      msgSeq: 42,
      msgId: 10042,
      elements,
    });
    if (!event) throw new Error('message conversion returned no event');
    const message = [{ type: 'face', data: { id: '114', resultId: '0' } }];
    expect(event.message).toEqual(message);
    expect(event.raw_message).toBe('[CQ:face,id=114,resultId=0]');
    await expect(parseMessage(String(event.raw_message), false)).resolves.toEqual(elements);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-face-animation-'));
    const dbPath = path.join(dir, 'messages.db');
    let store = new MessageStore(dbPath);
    try {
      store.storeEvent(Number(event.message_id), true, 30001, 42, GROUP_MESSAGE_EVENT, event);
      store.close();
      store = new MessageStore(dbPath);
      expect(store.findEvent(Number(event.message_id))?.message).toEqual(message);
      const history = await getGroupMsgHistory(store, 30001, undefined, 20);
      expect(history).toHaveLength(1);
      expect(history[0].message).toEqual(message);
      expect(history[0].raw_message).toBe(event.raw_message);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes an opaque result identifier without changing its value', async () => {
    const resultId = 'a,b&[c]';
    const raw = segmentsToRawMessage([{ type: 'face', data: { id: '114', resultId } }]);
    await expect(parseMessage(raw, false)).resolves.toEqual([{ type: 'face', faceId: 114, resultId }]);
  });
});
