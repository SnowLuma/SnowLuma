import {
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import type { IdentityService } from '@snowluma/protocol/identity-service';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { PkgType } from '@snowluma/protocol/msg-push/enums';
import { MsgPushRegistry } from '@snowluma/protocol/msg-push/registry';
import { afterEach, describe, expect, it } from 'vitest';

const previousLogLevel = getLogLevel();

afterEach(() => {
  setLogLevel(previousLogLevel);
});

function context(msgType: number): MsgPushContext {
  return {
    head: {
      msgType,
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
    identity: {} as IdentityService,
    isHistorical: false,
  };
}

function traceMessages(entries: LogEntry[]): string[] {
  return entries
    .filter((entry) => entry.level === 'trace')
    .map((entry) => entry.message);
}

describe('MsgPushRegistry TRACE branches', () => {
  it('records an unregistered decoder with its message identity', () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const registry = new MsgPushRegistry();

      expect(registry.decode(context(9999))).toEqual([]);
      expect(traceMessages(entries)).toContain(
        'packet_branch branch=decoder_unregistered msgType=9999 subType=7 messageSeq=88',
      );
    } finally {
      unsubscribe();
    }
  });

  it('records a decoder exception before failing open', () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const registry = new MsgPushRegistry();
      registry.register(PkgType.PrivateMessage, () => {
        throw new Error('fixture decode failed');
      });

      expect(registry.decode(context(PkgType.PrivateMessage))).toEqual([]);
      expect(traceMessages(entries)).toContain(
        'packet_branch branch=decoder_exception msgType=166 subType=7 messageSeq=88 error="fixture decode failed"',
      );
    } finally {
      unsubscribe();
    }
  });
});
