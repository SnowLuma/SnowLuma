// Send-chain micro-benchmark (RoadMap #5).
//
// Measured paths:
//   1. `parseMessage` — OneBot input (CQ string / segment array) →
//      MessageElement[]. The parse cost only.
//   2. `buildSendElems` — MessageElement[] → wire-proto Elem[]. The
//      transform cost (skipped: image/video/record because they hit
//      OIDB upload + need a Bridge; we only measure text-family).
//   3. `messageStore.storeMeta` — single SQLite write per send. The
//      per-send DB cost.
//   4. `messageStore.storeEvent` — synthetic self-sent event store.
//      Bigger DB write (includes JSON payload).
//
// Run via:  pnpm -F @snowluma/onebot bench
//
// Output is `tinybench` ops/sec. Run before AND after a perf commit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bench, describe } from 'vitest';
import { parseMessage } from '../src/message-parser';
import { MessageStore } from '../src/message-store';
import type { JsonObject } from '@snowluma/common/json';

// ─── parseMessage inputs ───

const CQ_TEXT = 'hello world from bench';
const CQ_MIXED = '[CQ:at,qq=123456] hello [CQ:face,id=76] world [CQ:reply,id=4242]';

const SEGMENTS_TEXT = [
  { type: 'text', data: { text: 'hello world from bench' } },
];
const SEGMENTS_MIXED = [
  { type: 'at', data: { qq: '123456' } },
  { type: 'text', data: { text: ' hello ' } },
  { type: 'face', data: { id: 76 } },
  { type: 'text', data: { text: ' world ' } },
  { type: 'reply', data: { id: 4242 } },
];

// ─── messageStore setup ───

function makeMessageStore(): MessageStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-bench-send-'));
  return new MessageStore(path.join(dir, 'messages.db'));
}

const store = makeMessageStore();

const META = {
  isGroup: true,
  targetId: 123456789,
  sequence: 1000,
  eventName: 'message.group',
  clientSequence: 12345,
  random: 67890,
  timestamp: 1710000000,
};

const SAMPLE_EVENT: JsonObject = {
  time: 1710000000,
  self_id: 10001,
  post_type: 'message_sent',
  message_type: 'group',
  sub_type: 'normal',
  message_id: 999999,
  message_seq: 1000,
  group_id: 123456789,
  user_id: 10001,
  message: [{ type: 'text', data: { text: 'hello world' } }],
  raw_message: 'hello world',
  font: 0,
  sender: { user_id: 10001, nickname: '', sex: 'unknown', age: 0 },
};

// ─── Benches ───

describe('parseMessage — OneBot input → MessageElement[]', () => {
  bench('CQ string (text only)', async () => {
    await parseMessage(CQ_TEXT, false);
  });
  bench('CQ string (mixed 4 segments)', async () => {
    await parseMessage(CQ_MIXED, false);
  });
  bench('segment array (text only)', async () => {
    await parseMessage(SEGMENTS_TEXT as any, false);
  });
  bench('segment array (5 segments)', async () => {
    await parseMessage(SEGMENTS_MIXED as any, false);
  });
});

describe('messageStore — SQLite writes per send', () => {
  // Use a monotonically-incrementing messageId so each call hits the
  // upsert path uniquely; otherwise we'd be testing the ON-CONFLICT
  // branch which is a different cost profile.
  let id1 = 100_000;
  let id2 = 200_000;
  bench('storeMeta', () => {
    store.storeMeta(id1++, META);
  });
  bench('storeEvent (JSON payload ~250 bytes)', () => {
    store.storeEvent(id2++, true, META.targetId, META.sequence, META.eventName, SAMPLE_EVENT);
  });
});

describe('messageStore — read paths', () => {
  // Seed a small set of records so findEvent / findMeta have hits.
  for (let i = 0; i < 100; i++) {
    store.storeMeta(500_000 + i, META);
    store.storeEvent(600_000 + i, true, META.targetId, META.sequence + i, META.eventName, SAMPLE_EVENT);
  }
  bench('findMeta (hit)', () => {
    store.findMeta(500_050);
  });
  bench('findMeta (miss)', () => {
    store.findMeta(9_999_999);
  });
  bench('findEvent (hit, JSON.parse on read)', () => {
    store.findEvent(600_050);
  });
});
