import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SsoReadedReportReq,
  SsoReadedReportResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

const {
  fetchGroupMessageRange,
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
} = vi.hoisted(() => ({
  fetchGroupMessageRange: vi.fn(),
  fetchC2cMessageRange: vi.fn(),
  fetchC2cRoamMessagePage: vi.fn(),
}));

vi.mock('@snowluma/protocol/msg-push', () => ({
  fetchGroupMessageRange,
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
}));

vi.mock('../src/bridge/apis/history-request-gate', () => ({
  HistoryRequestGate: class {
    run<T>(_gap: number, operation: () => Promise<T>): Promise<T> {
      return operation();
    }
  },
}));

import {
  LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS,
  MessageApi,
} from '../src/bridge/apis/message';
import { mockBridge } from './actions/_helpers';

function readReportResult(response: SsoReadedReportResp) {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<SsoReadedReportResp>(response)),
  };
}

describe('MessageApi login history sync seam', () => {
  beforeEach(() => {
    fetchGroupMessageRange.mockReset();
    fetchC2cMessageRange.mockReset();
    fetchC2cRoamMessagePage.mockReset();
  });

  it('probes server cursors once without sending a read confirmation', async () => {
    const sendRawPacket = vi.fn(async (
      _serviceCmd: string,
      _body: Uint8Array,
    ) => readReportResult({
      groupList: [{
        groupUin: 12345n,
        readSeq: 90n,
        latestSeq: 120n,
      }],
      c2cList: [{
        targetUin: 54321n,
        uid: 'u_friend',
        readSeq: 70n,
        latestSeq: 80n,
        lastMsgTime: 1_700_000_000n,
      }],
    }));
    const bridge = mockBridge({ sendRawPacket });

    const state = await new MessageApi(bridge as any).probeHistorySyncState(
      [12345],
      [{ userId: 54321, uid: 'u_friend' }],
    );

    expect(state).toEqual({
      groups: [{ groupId: 12345, readSeq: 90, latestSeq: 120 }],
      privateUsers: [{
        userId: 54321,
        uid: 'u_friend',
        readSeq: 70,
        latestSeq: 80,
        lastMsgTime: 1_700_000_000,
      }],
    });
    expect(sendRawPacket).toHaveBeenCalledOnce();
    expect(sendRawPacket.mock.calls[0]![0]).toBe(
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
    );
    const request = protobuf_decode<SsoReadedReportReq>(sendRawPacket.mock.calls[0]![1]);
    expect(request).toEqual({
      groupList: [{ groupUin: 12345n, lastReadSeq: null }],
      c2cList: [{ uid: 'u_friend', lastReadTime: null, lastReadSeq: null }],
    });
  });

  it('rejects an oversized probe before sending a packet', async () => {
    const bridge = mockBridge();
    const groups = Array.from(
      { length: LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS.maxTargetsPerKind + 1 },
      (_, index) => 10_000 + index,
    );

    await expect(
      new MessageApi(bridge as any).probeHistorySyncState(groups, []),
    ).rejects.toThrow(/at most 100 group targets/);

    expect(bridge.sendRawPacket).not.toHaveBeenCalled();
  });

  it('keeps explicit read-report failures observable', async () => {
    const sendRawPacket = vi.fn(async () => readReportResult({
      groupList: [{
        resultCode: 42,
        errorMessage: 'probe rejected',
        groupUin: 12345n,
      }],
    }));
    const bridge = mockBridge({ sendRawPacket });

    await expect(
      new MessageApi(bridge as any).probeHistorySyncState([12345], []),
    ).rejects.toThrow('probe rejected');

    expect(sendRawPacket).toHaveBeenCalledOnce();
  });

  it('fetches at most one bounded group history page', async () => {
    fetchGroupMessageRange.mockResolvedValue([
      { kind: 'group_message', msgSeq: 101 },
      { kind: 'group_message', msgSeq: 102 },
    ]);
    const bridge = mockBridge();

    const result = await new MessageApi(bridge as any).getGroupHistorySyncPage(
      12345,
      101,
      120,
      10001,
    );

    expect(fetchGroupMessageRange).toHaveBeenCalledOnce();
    expect(fetchGroupMessageRange).toHaveBeenCalledWith(
      bridge,
      bridge.identity,
      10001,
      12345,
      101,
      120,
    );
    expect(result.map((message: { msgSeq: number }) => message.msgSeq)).toEqual([101, 102]);

    await expect(
      new MessageApi(bridge as any).getGroupHistorySyncPage(12345, 1, 21, 10001),
    ).rejects.toThrow(/at most 20 sequence slots/);
    expect(fetchGroupMessageRange).toHaveBeenCalledOnce();
  });

  it('fetches at most one bounded private roam page', async () => {
    fetchC2cRoamMessagePage.mockResolvedValue({
      messages: [
        { kind: 'friend_message', ntMsgSeq: 10, time: 100 },
        { kind: 'friend_message', ntMsgSeq: 11, time: 101 },
      ],
      cursor: { time: 99, random: 1 },
    });
    const bridge = mockBridge();

    const result = await new MessageApi(bridge as any).getC2cLatestHistorySyncPage(
      'u_friend',
      20,
      10001,
      1_700_000_001,
    );

    expect(fetchC2cRoamMessagePage).toHaveBeenCalledOnce();
    expect(fetchC2cRoamMessagePage).toHaveBeenCalledWith(
      bridge,
      bridge.identity,
      10001,
      'u_friend',
      1_700_000_001,
      20,
      0,
    );
    expect(result).toHaveLength(2);

    await expect(
      new MessageApi(bridge as any).getC2cLatestHistorySyncPage(
        'u_friend',
        21,
        10001,
      ),
    ).rejects.toThrow(/at most 20 messages/);
    expect(fetchC2cRoamMessagePage).toHaveBeenCalledOnce();
  });

  it('fetches one bounded private sequence page without pagination', async () => {
    fetchC2cMessageRange.mockResolvedValue([
      { kind: 'friend_message', ntMsgSeq: 201 },
      { kind: 'friend_message', ntMsgSeq: 202 },
    ]);
    const bridge = mockBridge();

    const result = await new MessageApi(bridge as any).getC2cHistorySyncPage(
      'u_friend',
      201,
      220,
      10001,
    );

    expect(fetchC2cMessageRange).toHaveBeenCalledOnce();
    expect(fetchC2cMessageRange).toHaveBeenCalledWith(
      bridge,
      bridge.identity,
      10001,
      'u_friend',
      201,
      220,
    );
    expect(result.map(message => message.ntMsgSeq ?? 0))
      .toEqual([201, 202]);
  });
});
