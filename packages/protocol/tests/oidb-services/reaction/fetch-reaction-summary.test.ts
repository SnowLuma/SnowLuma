import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x9084Req, Oidb0x9084Resp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchReactionSummary } from '../../../src/oidb-services/reaction/fetch-reaction-summary';

function makeSender(resp?: Buffer) {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: resp ?? Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => defaultResp) };
}

describe('FetchReactionSummary namespace', () => {
  it('declares command = 0x9084 and subCommand = 1', () => {
    expect(FetchReactionSummary.command).toBe(0x9084);
    expect(FetchReactionSummary.subCommand).toBe(1);
  });

  describe('serialize', () => {
    it('encodes groupId/sequence as BigInt for uint_64 fields', () => {
      const out = FetchReactionSummary.serialize({} as any, { groupId: 1022489779, sequence: 1730183 });
      expect(out.groupId).toBe(1022489779n);
      expect(out.sequence).toBe(1730183n);
    });

    it('passes empty / default values for the unused filter fields', () => {
      const out = FetchReactionSummary.serialize({} as any, { groupId: 1, sequence: 1 });
      expect(out.emojiId).toBe('');
      expect(out.emojiType).toBe(0);
      expect(out.count).toBe(0);
      expect(out.field12).toBe(1);
    });

    it('emits a 0-length cookie buffer (no continuation)', () => {
      const out = FetchReactionSummary.serialize({} as any, { groupId: 1, sequence: 1 });
      expect(out.cookie).toBeInstanceOf(Uint8Array);
      expect(out.cookie!.length).toBe(0);
    });
  });

  describe('deserialize', () => {
    it('keeps entries with count > 0 (used emojis)', () => {
      const body: Oidb0x9084Resp = {
        entries: [
          { lastReactionTime: 1779456439n, count: 3, emojiType: 1, emojiId: '76' },
          { lastReactionTime: 1779456962n, count: 1, emojiType: 1, emojiId: '124' },
        ],
      };
      expect(FetchReactionSummary.deserialize({} as any, body)).toEqual([
        { emojiId: '76',  emojiType: 1, count: 3, lastReactionTime: 1779456439 },
        { emojiId: '124', emojiType: 1, count: 1, lastReactionTime: 1779456962 },
      ]);
    });

    it('filters out catalog-tail entries (count omitted ≡ 0)', () => {
      const body: Oidb0x9084Resp = {
        entries: [
          { lastReactionTime: 1n, count: 1, emojiType: 1, emojiId: '76' },
          { emojiType: 1, emojiId: '124' }, // catalog entry
          { emojiType: 1, emojiId: '66'  }, // catalog entry
        ],
      };
      const out = FetchReactionSummary.deserialize({} as any, body);
      expect(out).toHaveLength(1);
      expect(out[0]!.emojiId).toBe('76');
    });

    it('returns an empty array when the response has no entries', () => {
      expect(FetchReactionSummary.deserialize({} as any, {})).toEqual([]);
    });

    it('defaults emojiId / emojiType to safe values when omitted', () => {
      const body: Oidb0x9084Resp = {
        entries: [{ count: 5, lastReactionTime: 1700000000n }],
      };
      const [entry] = FetchReactionSummary.deserialize({} as any, body);
      expect(entry).toEqual({
        emojiId: '', emojiType: 1, count: 5, lastReactionTime: 1700000000,
      });
    });

    it('reports lastReactionTime=0 when omitted on a used entry (degenerate but defensive)', () => {
      const body: Oidb0x9084Resp = { entries: [{ count: 2, emojiId: 'x', emojiType: 1 }] };
      expect(FetchReactionSummary.deserialize({} as any, body)[0]!.lastReactionTime).toBe(0);
    });
  });

  describe('invoke (e2e via mock sender)', () => {
    it('sends to OidbSvcTrpcTcp.0x9084_1', async () => {
      const sender = makeSender();
      await FetchReactionSummary.invoke(sender, { groupId: 1, sequence: 1 });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x9084_1');
    });

    it('end-to-end: encode → decode pipeline yields the parsed summary entries', async () => {
      const respEnvelope = Buffer.from(protobuf_encode<OidbBase<Oidb0x9084Resp>>({
        command: 0x9084, subCommand: 1,
        body: {
          entries: [
            { lastReactionTime: 1700000000n, count: 5, emojiType: 1, emojiId: '76' },
            { emojiType: 1, emojiId: '124' }, // catalog noise
          ],
        },
      }));
      const sender = makeSender(respEnvelope);
      const result = await FetchReactionSummary.invoke(sender, { groupId: 1, sequence: 1 });
      expect(result).toEqual([
        { emojiId: '76', emojiType: 1, count: 5, lastReactionTime: 1700000000 },
      ]);
    });

    it('encodes the request envelope with groupId/sequence as uint_64', async () => {
      const sender = makeSender();
      await FetchReactionSummary.invoke(sender, { groupId: 1022489779, sequence: 1730183 });
      const [, reqBytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x9084Req>>(reqBytes);
      expect(env.command).toBe(0x9084);
      expect(env.subCommand).toBe(1);
      expect(env.body?.groupId).toBe(1022489779n);
      expect(env.body?.sequence).toBe(1730183n);
    });

    it('returns an empty array when server responds with empty envelope', async () => {
      const sender = makeSender();
      const result = await FetchReactionSummary.invoke(sender, { groupId: 1, sequence: 1 });
      expect(result).toEqual([]);
    });
  });
});
