// Receive-chain micro-benchmark (RoadMap #5).
//
// Measured paths:
//   1. `parseMsgPush` — pure decode + decoder dispatch (no SQLite, no
//      event emit). The protobuf workload only.
//   2. `IncomingPacketPipeline.process` — full receive pipeline:
//      decode + decoder + handleSideEffects (identity-service SQLite
//      writes) + event emit through BridgeEventBus.
//
// Run via:  pnpm -F @snowluma/bridge bench
//
// Output is `tinybench` ops/sec — vitest's built-in `bench()` is just a
// thin wrapper. Run before AND after a perf commit; the delta is what
// matters (RoadMap #5 commit messages quote the % shift).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bench, describe } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { parseMsgPush, MSG_PUSH_CMD } from '../src/msg-push/index';
import { IdentityService } from '../src/identity-service';
import { BridgeEventBus } from '../src/event-bus';
import { IncomingPacketPipeline } from '../src/packet-pipeline';

const SELF_UIN = '10001';
const GROUP_ID = 123456789;
const SENDER_UIN = 22222;
const SENDER_UID = 'u_sender';

// ─── Synthetic packet builders ───

function makeGroupTextPacket(): PacketInfo {
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin: SENDER_UIN, fromUid: SENDER_UID },
      contentHead: {
        msgType: 82,
        subType: 1,
        sequence: 1234,
        timestamp: 1710000000,
        msgId: 999999,
      },
      body: {
        richText: {
          elems: [{ text: { str: 'hello world from bench' } }],
        },
      },
    },
    status: 0,
    grpInfo: { groupUin: GROUP_ID },
  } as any);
  return {
    pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD,
    seqId: 1, retCode: 0, fromClient: false, body,
  };
}

function makeGroupMixedPacket(): PacketInfo {
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin: SENDER_UIN, fromUid: SENDER_UID },
      contentHead: {
        msgType: 82,
        subType: 1,
        sequence: 1235,
        timestamp: 1710000000,
        msgId: 999998,
      },
      body: {
        richText: {
          elems: [
            { text: { str: '@some_user ' } },
            { face: { index: 76 } },
            { text: { str: 'hello ' } },
            { srcMsg: { origSeqs: [4242] } },
            { text: { str: ' world' } },
          ],
        },
      },
    },
    status: 0,
    grpInfo: { groupUin: GROUP_ID },
  } as any);
  return {
    pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD,
    seqId: 2, retCode: 0, fromClient: false, body,
  };
}

function makeGroupJoinPacket(): PacketInfo {
  const content = protobuf_encode<GroupChange>({
    groupUin: GROUP_ID,
    memberUid: 'u_newcomer',
  });
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin: GROUP_ID },
      contentHead: { msgType: 33, timestamp: 1710000000 },
      body: { msgContent: content },
    },
    status: 0,
  } as any);
  return {
    pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD,
    seqId: 3, retCode: 0, fromClient: false, body,
  };
}

// ─── Setup helpers ───

// In-memory identity (no SQLite writes) — used for the "pure decode"
// bench to isolate proton + decoder cost from DB cost.
function makeIdentity(): IdentityService {
  return IdentityService.memory(SELF_UIN);
}

// SQLite-backed identity in a temp file — used for the full-pipeline
// bench so we capture per-event identity writes. Temp dir is cleaned
// implicitly on process exit (OS tmp policy); we don't need to unlink
// because each `bench()` recreates it.
function makeIdentityWithDb(): IdentityService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-bench-recv-'));
  return new IdentityService(SELF_UIN, path.join(dir, 'identity.db'));
}

function makePipeline(identity: IdentityService): IncomingPacketPipeline {
  const events = new BridgeEventBus();
  events.on('group_message', () => { /* drain */ });
  events.on('group_member_join', () => { /* drain */ });
  const pipeline = new IncomingPacketPipeline({
    identity,
    events,
    refreshMemberCache: async () => false,
  });
  pipeline.registerCmd(MSG_PUSH_CMD, parseMsgPush);
  return pipeline;
}

// ─── Benches ───

const groupText = makeGroupTextPacket();
const groupMixed = makeGroupMixedPacket();
const groupJoin = makeGroupJoinPacket();

describe('parseMsgPush — pure decode + dispatch (no SQLite, no emit)', () => {
  const identityPure = makeIdentity();
  bench('group_message (text only)', () => {
    parseMsgPush(groupText, identityPure);
  });
  bench('group_message (5 mixed elements)', () => {
    parseMsgPush(groupMixed, identityPure);
  });
  bench('group_member_join', () => {
    parseMsgPush(groupJoin, identityPure);
  });
});

describe('IncomingPacketPipeline.process — full pipeline (with SQLite identity writes)', () => {
  const pipelineText = makePipeline(makeIdentityWithDb());
  const pipelineMixed = makePipeline(makeIdentityWithDb());
  const pipelineJoin = makePipeline(makeIdentityWithDb());

  bench('group_message (text only)', () => {
    pipelineText.process(groupText);
  });
  bench('group_message (5 mixed elements)', () => {
    pipelineMixed.process(groupMixed);
  });
  bench('group_member_join', () => {
    pipelineJoin.process(groupJoin);
  });
});
