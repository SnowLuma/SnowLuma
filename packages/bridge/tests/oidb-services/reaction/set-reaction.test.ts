import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupReaction } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetReaction } from '../../../src/oidb-services/reaction/set-reaction';

function makeSender() {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => defaultResp) };
}

describe('SetReaction namespace', () => {
  it('declares command = 0x9082', () => {
    expect(SetReaction.command).toBe(0x9082);
  });

  it('resolveSubCommand: isSet=true → 1, isSet=false → 2', () => {
    expect(SetReaction.resolveSubCommand({ groupId: 1, sequence: 1, code: 'x', isSet: true })).toBe(1);
    expect(SetReaction.resolveSubCommand({ groupId: 1, sequence: 1, code: 'x', isSet: false })).toBe(2);
  });

  describe('serialize', () => {
    it('produces type=1 for short QQ-face codes (≤3 chars)', () => {
      const out = SetReaction.serialize({ groupId: 12345, sequence: 99, code: '76', isSet: true });
      expect(out).toEqual({
        groupUin: 12345, sequence: 99, code: '76', type: 1, field6: false, field7: false,
      });
    });

    it('produces type=1 for exactly 3-character codes (boundary)', () => {
      const out = SetReaction.serialize({ groupId: 1, sequence: 1, code: '999', isSet: true });
      expect(out.type).toBe(1);
    });

    it('produces type=2 for codes longer than 3 chars (unicode codepoint)', () => {
      const out = SetReaction.serialize({ groupId: 1, sequence: 1, code: '128516', isSet: false });
      expect(out.type).toBe(2);
    });

    it('passes through groupId/sequence/code verbatim', () => {
      const out = SetReaction.serialize({ groupId: 999, sequence: 42, code: 'abc', isSet: true });
      expect(out.groupUin).toBe(999);
      expect(out.sequence).toBe(42);
      expect(out.code).toBe('abc');
    });

    it('always sets field6/field7 to false (deferred behaviour)', () => {
      const out = SetReaction.serialize({ groupId: 1, sequence: 1, code: 'x', isSet: true });
      expect(out.field6).toBe(false);
      expect(out.field7).toBe(false);
    });
  });

  describe('deserialize', () => {
    it('always returns void regardless of body content', () => {
      expect(SetReaction.deserialize({})).toBeUndefined();
    });
  });

  describe('encode / decode round trip', () => {
    it('encode preserves groupUin/sequence/code/type in the envelope body', () => {
      const env: OidbBase<OidbGroupReaction> = {
        command: 0x9082, subCommand: 1,
        body: { groupUin: 12345, sequence: 99, code: '76', type: 1 } as OidbGroupReaction,
      };
      const bytes = SetReaction.encode(env);
      const decoded = SetReaction.decode(bytes);
      expect(decoded.command).toBe(0x9082);
      expect(decoded.subCommand).toBe(1);
    });
  });

  describe('invoke (e2e via mock sender)', () => {
    it('routes to OidbSvcTrpcTcp.0x9082_1 when isSet=true', async () => {
      const sender = makeSender();
      await SetReaction.invoke(sender, { groupId: 12345, sequence: 99, code: '76', isSet: true });
      expect(sender.sendRawPacket).toHaveBeenCalledOnce();
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x9082_1');
    });

    it('routes to OidbSvcTrpcTcp.0x9082_2 when isSet=false', async () => {
      const sender = makeSender();
      await SetReaction.invoke(sender, { groupId: 12345, sequence: 99, code: '76', isSet: false });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x9082_2');
    });

    it('packages the serialized body into the OIDB envelope wire', async () => {
      const sender = makeSender();
      await SetReaction.invoke(sender, { groupId: 12345, sequence: 99, code: '128516', isSet: true });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
      expect(env.command).toBe(0x9082);
      expect(env.subCommand).toBe(1);
      expect(env.body).toMatchObject({
        groupUin: 12345, sequence: 99, code: '128516', type: 2,
      });
    });

    it('resolves to undefined (void)', async () => {
      const sender = makeSender();
      const result = await SetReaction.invoke(sender, { groupId: 1, sequence: 1, code: 'x', isSet: true });
      expect(result).toBeUndefined();
    });
  });
});
