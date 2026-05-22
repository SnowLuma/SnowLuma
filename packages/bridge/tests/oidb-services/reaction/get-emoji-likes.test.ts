import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x9083Req, Oidb0x9083Resp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetEmojiLikes } from '../../../src/oidb-services/reaction/get-emoji-likes';

function makeSender(resp?: Buffer) {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: resp ?? Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => defaultResp) };
}

describe('GetEmojiLikes namespace', () => {
  it('declares command = 0x9083 and subCommand = 1', () => {
    expect(GetEmojiLikes.command).toBe(0x9083);
    expect(GetEmojiLikes.subCommand).toBe(1);
  });

  describe('serialize', () => {
    it('encodes groupId/sequence as BigInt for uint_64 fields', () => {
      const out = GetEmojiLikes.serialize({
        groupId: 12345, sequence: 99, emojiId: '76',
      });
      expect(out.groupId).toBe(12345n);
      expect(out.sequence).toBe(99n);
    });

    it('passes emojiId through unchanged', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: '128516' });
      expect(out.emojiId).toBe('128516');
    });

    it('defaults emojiType to 1 when omitted', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x' });
      expect(out.emojiType).toBe(1);
    });

    it('uses caller-supplied emojiType when present', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x', emojiType: 2 });
      expect(out.emojiType).toBe(2);
    });

    it('defaults count to 10 when omitted', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x' });
      expect(out.count).toBe(10);
    });

    it('uses caller-supplied count when present', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x', count: 50 });
      expect(out.count).toBe(50);
    });

    it('decodes base64 cookie into the bytes field for continuation', () => {
      const cookie = Buffer.from([0xCA, 0xFE]).toString('base64');
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x', cookie });
      expect(out.cookie).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(out.cookie!).equals(Buffer.from([0xCA, 0xFE]))).toBe(true);
    });

    it('emits a 0-length cookie buffer for the first page (no cookie supplied)', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x' });
      expect(out.cookie!.length).toBe(0);
    });

    it('sets field7=0 and field12=1 (magic values matching the historic wire shape)', () => {
      const out = GetEmojiLikes.serialize({ groupId: 1, sequence: 1, emojiId: 'x' });
      expect(out.field7).toBe(0);
      expect(out.field12).toBe(1);
    });
  });

  describe('deserialize', () => {
    it('extracts users from inner.userInfo and base64-encodes the cookie', () => {
      const result = GetEmojiLikes.deserialize({
        inner: { userInfo: [{ uin: 10001n }, { uin: 20002n }] },
        cookie: new Uint8Array([0xCA, 0xFE]),
      });
      expect(result.users).toEqual([{ uin: 10001 }, { uin: 20002 }]);
      expect(result.cookie).toBe(Buffer.from([0xCA, 0xFE]).toString('base64'));
      expect(result.isLast).toBe(false);
    });

    it('filters out users with uin=0 (placeholder / zero-value)', () => {
      const result = GetEmojiLikes.deserialize({
        inner: { userInfo: [{ uin: 10001n }, { uin: 0n }, { uin: 20002n }] },
      });
      expect(result.users).toEqual([{ uin: 10001 }, { uin: 20002 }]);
    });

    it('returns empty users + empty cookie + isLast=true when body has nothing', () => {
      const result = GetEmojiLikes.deserialize({});
      expect(result.users).toEqual([]);
      expect(result.cookie).toBe('');
      expect(result.isLast).toBe(true);
    });

    it('returns isLast=true when cookie is absent (final page)', () => {
      const result = GetEmojiLikes.deserialize({
        inner: { userInfo: [{ uin: 10001n }] },
      });
      expect(result.isLast).toBe(true);
    });

    it('handles missing userInfo entries field', () => {
      const result = GetEmojiLikes.deserialize({ inner: {} });
      expect(result.users).toEqual([]);
    });
  });

  describe('invoke (e2e via mock sender)', () => {
    it('sends to OidbSvcTrpcTcp.0x9083_1', async () => {
      const sender = makeSender();
      await GetEmojiLikes.invoke(sender, { groupId: 1, sequence: 1, emojiId: '76' });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x9083_1');
    });

    it('end-to-end: encode → decode yields parsed user list + cookie', async () => {
      const respEnvelope = Buffer.from(protobuf_encode<OidbBase<Oidb0x9083Resp>>({
        command: 0x9083, subCommand: 1,
        body: {
          inner: { userInfo: [{ uin: 10001n }] },
          cookie: new Uint8Array([0xDE, 0xAD]),
        } as any,
      }));
      const sender = makeSender(respEnvelope);
      const result = await GetEmojiLikes.invoke(sender, { groupId: 1, sequence: 1, emojiId: '76' });
      expect(result.users).toEqual([{ uin: 10001 }]);
      expect(result.cookie).toBe(Buffer.from([0xDE, 0xAD]).toString('base64'));
      expect(result.isLast).toBe(false);
    });

    it('returns the legacy-stub empty result when server returns ack-only', async () => {
      const sender = makeSender();
      const result = await GetEmojiLikes.invoke(sender, { groupId: 1, sequence: 1, emojiId: '76' });
      expect(result).toEqual({ users: [], cookie: '', isLast: true });
    });

    it('encodes the request envelope with proper field types', async () => {
      const sender = makeSender();
      await GetEmojiLikes.invoke(sender, {
        groupId: 12345, sequence: 99, emojiId: '128516', emojiType: 2, count: 20,
      });
      const [, reqBytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x9083Req>>(reqBytes);
      expect(env.command).toBe(0x9083);
      expect(env.subCommand).toBe(1);
      expect(env.body?.groupId).toBe(12345n);
      expect(env.body?.sequence).toBe(99n);
      expect(env.body?.emojiId).toBe('128516');
      expect(env.body?.emojiType).toBe(2);
      expect(env.body?.count).toBe(20);
    });
  });
});
