import {
  currentRequestId,
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { PkgType } from '@snowluma/protocol/msg-push/enums';
import { MsgPushRegistry } from '@snowluma/protocol/msg-push/registry';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { afterEach, describe, expect, it, vi } from 'vitest';

const previousLogLevel = getLogLevel();

afterEach(() => {
  setLogLevel(previousLogLevel);
  vi.restoreAllMocks();
});

function packet(serviceCmd = 'Trace.Command'): PacketInfo {
  return {
    pid: 42,
    uin: '10001',
    serviceCmd,
    seqId: 77,
    retCode: 0,
    fromClient: false,
    body: Buffer.from([0x00, 0xff]),
  };
}

function friendEvent(): QQEventVariant {
  return {
    kind: 'friend_message',
    time: 1,
    selfUin: 10001,
    senderUin: 20002,
    senderUid: 'u_peer',
    senderNick: 'peer',
    msgSeq: 1,
    msgId: 2,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function msgPushContext(
  identity: IdentityService,
): MsgPushContext {
  return {
    head: {
      msgType: PkgType.PrivateMessage,
      subType: 7,
      c2cCmd: 0,
      sequence: 88,
      ntMsgSeq: 0,
      timestamp: 1,
      msgId: 2,
    },
    fromUin: 20002,
    fromUid: 'u_peer',
    selfUin: 10001,
    content: new Uint8Array(0),
    body: undefined,
    responseHead: undefined,
    identity,
    isHistorical: false,
  };
}

function makePipeline(opts: {
  fetchGroupList?: () => Promise<void>;
  fetchGroupMemberList?: (groupId: number) => Promise<void>;
  fetchProfileByUid?: () => Promise<{ uin: number; uid: string; nickname: string; remark: string; qid: string; sex: string; age: number; sign: string; avatar: string; level: number }>;
} = {}) {
  const identity = IdentityService.memory('10001');
  if (opts.fetchProfileByUid) {
    identity.setFetcher({
      fetchProfile: async () => ({
        uin: 0, uid: '', nickname: '', remark: '', qid: '', sex: 'unknown',
        age: 0, sign: '', avatar: '', level: 0,
      }),
      fetchProfileByUid: opts.fetchProfileByUid,
    });
  }
  const events = new BridgeEventBus();
  const pipeline = new IncomingPacketPipeline({
    identity,
    events,
    fetchGroupList: opts.fetchGroupList ?? vi.fn(async () => {}),
    fetchGroupMemberList: opts.fetchGroupMemberList ?? vi.fn(async () => {}),
    resolveGroupJoinRequest: vi.fn(async () => null),
  });
  const dispatched: Array<{ event: QQEventVariant; req: number | undefined }> = [];
  events.onAny((event) => {
    dispatched.push({ event: event as QQEventVariant, req: currentRequestId() });
  });
  return { pipeline, dispatched, identity };
}

function packetTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.level === 'trace' && entry.scope === 'Protocol.Packet');
}

describe('IncomingPacketPipeline TRACE lifecycle', () => {
  it('records an unregistered command as one dropped terminal', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline } = makePipeline();

      await pipeline.process(packet('Unknown.Command'));

      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Unknown.Command" seqId=77 branch=parser_unregistered',
        expect.stringMatching(/^packet_terminal serviceCmd="Unknown\.Command" seqId=77 outcome=dropped reason=parser_unregistered events=0 dispatched=0 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('classifies a decoder exception as a parser failure terminal', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, identity } = makePipeline();
      const registry = new MsgPushRegistry();
      registry.register(PkgType.PrivateMessage, () => {
        throw new Error('fixture decoder failed');
      });
      pipeline.registerCmd(
        'Trace.Command',
        () => registry.decodeOrThrow(msgPushContext(identity)),
      );

      await pipeline.process(packet());

      expect(entries).toContainEqual(expect.objectContaining({
        level: 'trace',
        scope: 'MsgPush',
        message: 'packet_branch branch=decoder_exception msgType=166 subType=7 messageSeq=88 error="fixture decoder failed"',
      }));
      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_exception error="fixture decoder failed"',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=failed reason=parser_exception events=0 dispatched=0 parserErrors=1 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('distinguishes zero events, parser exceptions, and synchronous dispatch', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, dispatched } = makePipeline();
      pipeline.registerCmd('Trace.Command', () => []);
      pipeline.registerCmd('Trace.Command', () => { throw new Error('fixture parser failed'); });
      pipeline.registerCmd('Trace.Command', () => [friendEvent()]);

      const completion = pipeline.process(packet());
      expect(dispatched).toHaveLength(1);
      await completion;

      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_zero_events',
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=2 branch=parser_exception error="fixture parser failed"',
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=3 branch=parser_events events=1',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=dispatch eventKind="friend_message" mode=sync',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=failed reason=parser_exception events=1 dispatched=1 parserErrors=1 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('classifies a synchronous dispatch exception and emits one failed terminal', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, identity } = makePipeline();
      vi.spyOn(identity, 'rememberRequestIdentity').mockImplementation(() => {
        throw new Error('fixture dispatch failed');
      });
      pipeline.registerCmd('Trace.Command', () => [
        friendEvent(),
        friendEvent(),
      ]);

      await pipeline.process(packet());

      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_events events=2',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=dispatch_exception eventKind="friend_message" error="fixture dispatch failed"',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=failed reason=dispatch_exception events=2 dispatched=0 parserErrors=0 dispatchErrors=1 elapsedMs=\d+$/),
      ]);
      expect(identity.rememberRequestIdentity).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it('completes join identity enrichment without treating roster refresh as the UIN hop', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, dispatched } = makePipeline({
        fetchGroupList: vi.fn(async () => {
          throw new Error('fixture refresh failed');
        }),
      });
      pipeline.registerCmd('Trace.Command', () => [{
        kind: 'group_member_join',
        time: 1,
        selfUin: 10001,
        groupId: 123,
        userUin: 0,
        operatorUin: 0,
        userUid: 'u_new_member',
        operatorUid: 'u_operator',
      }]);

      await pipeline.process(packet());

      expect(dispatched).toHaveLength(1);
      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_events events=1',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=enrichment_started eventKind="group_member_join" enrichment="identity_refresh"',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=dispatch eventKind="group_member_join" mode=enriched',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=completed reason=dispatch_complete events=1 dispatched=1 parserErrors=0 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('distinguishes enrichment failure from enriched dispatch failure', async () => {
    const enrichmentEntries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => enrichmentEntries.push(entry));
    try {
      const enrichment = makePipeline();
      vi.spyOn(enrichment.identity, 'rememberRequestIdentity')
        .mockImplementation(() => {
          throw new Error('fixture enrichment failed');
        });
      enrichment.pipeline.registerCmd('Trace.Command', () => [{
        kind: 'group_invite',
        time: 1,
        selfUin: 10001,
        groupId: 123,
        fromUin: 0,
        fromUid: 'u_stranger',
        subType: 'add',
        message: '',
        flag: 'add:123:u_stranger',
      } as QQEventVariant]);

      await enrichment.pipeline.process(packet());

      expect(packetTrace(enrichmentEntries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_events events=1',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=enrichment_started eventKind="group_invite" enrichment="group_invite"',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=enrichment_failed eventKind="group_invite" enrichment="group_invite" error="fixture enrichment failed"',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=failed reason=enrichment_failed events=1 dispatched=0 parserErrors=0 dispatchErrors=0 elapsedMs=\d+$/),
      ]);

      enrichmentEntries.length = 0;
      const dispatch = makePipeline();
      vi.spyOn(dispatch.identity, 'rememberGroupMemberIdentity')
        .mockImplementation(() => {
          throw new Error('fixture enriched dispatch failed');
        });
      dispatch.pipeline.registerCmd('Trace.Command', () => [{
        kind: 'group_member_join',
        time: 1,
        selfUin: 10001,
        groupId: 123,
        userUin: 0,
        operatorUin: 0,
        userUid: 'u_new_member',
        operatorUid: 'u_operator',
      }]);

      await dispatch.pipeline.process(packet());

      expect(packetTrace(enrichmentEntries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_events events=1',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=enrichment_started eventKind="group_member_join" enrichment="identity_refresh"',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=dispatch_exception eventKind="group_member_join" error="fixture enriched dispatch failed"',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=failed reason=dispatch_exception events=1 dispatched=0 parserErrors=0 dispatchErrors=1 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('retains request context through asynchronous enrichment before terminal', async () => {
    let release!: (value: { uin: number; nickname: string }) => void;
    const profile = new Promise<{ uin: number; nickname: string }>((resolve) => { release = resolve; });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, dispatched } = makePipeline({
        fetchProfileByUid: async () => {
          const resolved = await profile;
          return {
            uin: resolved.uin,
            uid: 'u_stranger',
            nickname: resolved.nickname,
            remark: '',
            qid: '',
            sex: 'unknown',
            age: 0,
            sign: '',
            avatar: '',
            level: 0,
          };
        },
      });
      pipeline.registerCmd('Trace.Command', () => [{
        kind: 'group_invite',
        time: 1,
        selfUin: 10001,
        groupId: 123,
        fromUin: 0,
        fromUid: 'u_stranger',
        subType: 'add',
        message: '',
        flag: 'add:123:u_stranger',
      } as QQEventVariant]);

      const completion = runWithRequestId(5101, () => pipeline.process(packet()));
      expect(dispatched).toHaveLength(0);
      release({ uin: 20002, nickname: 'resolved' });
      await completion;

      expect(dispatched).toEqual([
        expect.objectContaining({ req: 5101 }),
      ]);
      expect(packetTrace(entries)).toEqual(
        packetTrace(entries).map(() => expect.objectContaining({ req: 5101 })),
      );
      expect(packetTrace(entries).map((entry) => entry.message)).toEqual([
        'packet_branch serviceCmd="Trace.Command" seqId=77 parser=1 branch=parser_events events=1',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=enrichment_started eventKind="group_invite" enrichment="group_invite"',
        'packet_branch serviceCmd="Trace.Command" seqId=77 branch=dispatch eventKind="group_invite" mode=enriched',
        expect.stringMatching(/^packet_terminal serviceCmd="Trace\.Command" seqId=77 outcome=completed reason=dispatch_complete events=1 dispatched=1 parserErrors=0 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
    }
  });
});
