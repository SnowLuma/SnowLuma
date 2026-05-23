import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbGroupReaction } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import {
  buildOidbRequest,
  invokeOidb,
  OidbError,
  parseOidbResponse,
  type OidbCallSpec,
  type OidbSender,
} from '../src/oidb-service';

// Reused minimal spec — encodes a group-reaction-shaped request and
// reads back a void result. Exercises every spec branch.
const reactionSpec: OidbCallSpec<
  OidbSender, OidbGroupReaction, OidbEmpty,
  { groupId: number; sequence: number; code: string; isSet: boolean }, void
> = {
  command: 0x9082,
  resolveSubCommand: p => p.isSet ? 1 : 2,
  serialize: (_ctx, p) => ({
    groupUin: p.groupId,
    sequence: p.sequence,
    code: p.code,
    type: p.code.length > 3 ? 2 : 1,
    field6: false,
    field7: false,
  }),
  deserialize: () => {},
  encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
  decode: bytes => protobuf_decode<OidbBase<OidbEmpty>>(bytes),
};

// Static-subCommand variant for the branch test.
const staticSubSpec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbEmpty, { groupId: number }, void> = {
  command: 0xEAC,
  subCommand: 1,
  serialize: (_ctx, p) => ({ groupUin: p.groupId, sequence: 0, code: '', type: 1, field6: false, field7: false }),
  deserialize: () => {},
  encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
  decode: bytes => protobuf_decode<OidbBase<OidbEmpty>>(bytes),
};

function makeSender(resp: Partial<SendPacketResult> = {}): OidbSender & { sendRawPacket: ReturnType<typeof vi.fn> } {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return {
    sendRawPacket: vi.fn(async () => ({ ...defaultResp, ...resp })),
  };
}

describe('invokeOidb', () => {
  it('uses resolveSubCommand when present and computes the wire name', async () => {
    const sender = makeSender();
    await invokeOidb(sender, reactionSpec, { groupId: 12345, sequence: 99, code: '76', isSet: true });
    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
    const [wireName] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x9082_1');
  });

  it('flips wire name when resolveSubCommand returns a different subcmd', async () => {
    const sender = makeSender();
    await invokeOidb(sender, reactionSpec, { groupId: 1, sequence: 1, code: '76', isSet: false });
    const [wireName] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x9082_2');
  });

  it('uses static subCommand when resolveSubCommand is absent', async () => {
    const sender = makeSender();
    await invokeOidb(sender, staticSubSpec, { groupId: 12345 });
    const [wireName] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0xeac_1');
  });

  it('encodes serialize() output into an OIDB envelope (cmd + subcmd land in fields 1/2)', async () => {
    const sender = makeSender();
    await invokeOidb(sender, reactionSpec, { groupId: 12345, sequence: 99, code: '76', isSet: true });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
    expect(env.command).toBe(0x9082);
    expect(env.subCommand).toBe(1);
    expect(env.body).toMatchObject({
      groupUin: 12345, sequence: 99, code: '76', type: 1,
    });
  });

  it('passes the body through deserialize for transformation', async () => {
    type Echo = { tag: number };
    const spec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbGroupReaction, { code: string }, Echo> = {
      command: 0x9082,
      subCommand: 1,
      serialize: (_ctx, p) => ({ code: p.code }),
      deserialize: (_ctx, b) => ({ tag: b.type ?? 99 }),
      encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
      decode: bytes => protobuf_decode<OidbBase<OidbGroupReaction>>(bytes),
    };
    const responseEnvelope = protobuf_encode<OidbBase<OidbGroupReaction>>({
      command: 0x9082, subCommand: 1,
      body: { type: 5 } as OidbGroupReaction,
    });
    const sender = makeSender({ responseData: Buffer.from(responseEnvelope) });
    const result = await invokeOidb(sender, spec, { code: 'x' });
    expect(result).toEqual({ tag: 5 });
  });

  it('substitutes an empty body when the envelope has no field 4', async () => {
    const envBytes = protobuf_encode<OidbBase<OidbEmpty>>({ command: 0x9082, subCommand: 1 });
    const sender = makeSender({ responseData: Buffer.from(envBytes) });
    const deserialize = vi.fn(() => undefined);
    const spec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbEmpty, { code: string }, void> = {
      command: 0x9082, subCommand: 1,
      serialize: (_ctx, p) => ({ code: p.code }),
      deserialize,
      encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
      decode: bytes => protobuf_decode<OidbBase<OidbEmpty>>(bytes),
    };
    await invokeOidb(sender, spec, { code: 'x' });
    expect(deserialize).toHaveBeenCalledOnce();
    // deserialize now receives (ctx, body) — body is the second arg.
    expect(deserialize.mock.calls[0]![1]).toEqual({});
  });

  it('awaits async serialize before sending', async () => {
    // ctx-aware serialize may need to resolve a uid first; invokeOidb
    // must await it before encoding the envelope.
    const sender = makeSender();
    const spec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbEmpty, { code: string }, void> = {
      command: 0x9082, subCommand: 1,
      serialize: async (_ctx, p) => {
        await new Promise(r => setTimeout(r, 5));
        return { code: p.code, sequence: 42 };
      },
      deserialize: () => {},
      encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
      decode: bytes => protobuf_decode<OidbBase<OidbEmpty>>(bytes),
    };
    await invokeOidb(sender, spec, { code: 'async' });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
    expect(env.body?.code).toBe('async');
    expect(env.body?.sequence).toBe(42);
  });

  it('threads ctx into serialize so namespaces can read identity / resolve uids in place', async () => {
    const sender = makeSender();
    // Extend the ctx with an arbitrary capability the spec uses.
    type Ctx = OidbSender & { tag: string };
    const ctx: Ctx = { ...sender, tag: 'from-ctx' };
    const spec: OidbCallSpec<Ctx, OidbGroupReaction, OidbEmpty, { code: string }, void> = {
      command: 0x9082, subCommand: 1,
      serialize: (c, p) => ({ code: `${c.tag}/${p.code}` }),
      deserialize: () => {},
      encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
      decode: bytes => protobuf_decode<OidbBase<OidbEmpty>>(bytes),
    };
    await invokeOidb(ctx, spec, { code: 'x' });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
    expect(env.body?.code).toBe('from-ctx/x');
  });

  it('propagates timeoutMs to sendRawPacket', async () => {
    const sender = makeSender();
    await invokeOidb(sender, staticSubSpec, { groupId: 1 }, 5000);
    expect(sender.sendRawPacket.mock.calls[0]![2]).toBe(5000);
  });

  it('rethrows the sender errorMessage when success=false', async () => {
    const sender = makeSender({ success: false, errorMessage: 'boom' });
    await expect(invokeOidb(sender, staticSubSpec, { groupId: 1 })).rejects.toThrow('boom');
  });

  it('falls back to "packet send failed" when success=false and errorMessage is empty', async () => {
    const sender = makeSender({ success: false, errorMessage: '' });
    await expect(invokeOidb(sender, staticSubSpec, { groupId: 1 })).rejects.toThrow('packet send failed');
  });

  it('rethrows when sender returns success=true but gotResponse=false', async () => {
    const sender = makeSender({ success: true, gotResponse: false, errorMessage: 'timeout' });
    await expect(invokeOidb(sender, staticSubSpec, { groupId: 1 })).rejects.toThrow('timeout');
  });

  it('falls back to "no response" when gotResponse=false and errorMessage is empty', async () => {
    const sender = makeSender({ success: true, gotResponse: false, errorMessage: '' });
    await expect(invokeOidb(sender, staticSubSpec, { groupId: 1 })).rejects.toThrow('no response');
  });

  it('raises OidbError when envelope errorCode != 0', async () => {
    const errBytes = protobuf_encode<OidbBase<OidbEmpty>>({
      command: 0x9082, subCommand: 1, errorCode: 42, errorMsg: 'no privilege',
    });
    const sender = makeSender({ responseData: Buffer.from(errBytes) });
    let caught: unknown;
    try { await invokeOidb(sender, staticSubSpec, { groupId: 1 }); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(OidbError);
    expect((caught as OidbError).code).toBe(42);
    expect((caught as OidbError).serverMsg).toBe('no privilege');
    expect((caught as OidbError).command).toBe(0xEAC);
    expect((caught as OidbError).subCommand).toBe(1);
    expect((caught as OidbError).message).toContain('OIDB error 42');
    expect((caught as OidbError).message).toContain('0xeac_1');
  });

  it('skips OidbError check when response payload is empty', async () => {
    const sender = makeSender({ responseData: Buffer.alloc(0) });
    await expect(invokeOidb(sender, staticSubSpec, { groupId: 1 })).resolves.toBeUndefined();
  });

  it('honours uinForm=true by flipping OIDB envelope reserved to 1', async () => {
    const spec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbEmpty, { groupId: number }, void> = {
      ...staticSubSpec,
      uinForm: true,
    };
    const sender = makeSender();
    await invokeOidb(sender, spec, { groupId: 1 });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
    expect(env.reserved).toBe(1);
  });

  it('uses uinForm=false by default (envelope reserved=0)', async () => {
    const sender = makeSender();
    await invokeOidb(sender, staticSubSpec, { groupId: 1 });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupReaction>>(bytes);
    expect(env.reserved ?? 0).toBe(0);
  });
});

describe('buildOidbRequest', () => {
  it('returns the same wire name + bytes that invokeOidb would send', async () => {
    const sender = makeSender();
    await invokeOidb(sender, reactionSpec, { groupId: 12345, sequence: 99, code: '128516', isSet: true });
    const sentBytes = sender.sendRawPacket.mock.calls[0]![1];

    const built = await buildOidbRequest(sender, reactionSpec, { groupId: 12345, sequence: 99, code: '128516', isSet: true });
    expect(built.wireName).toBe('OidbSvcTrpcTcp.0x9082_1');
    expect(Buffer.from(built.bytes).equals(Buffer.from(sentBytes))).toBe(true);
  });

  it('uses static subCommand when resolveSubCommand is absent', async () => {
    const sender = makeSender();
    const built = await buildOidbRequest(sender, staticSubSpec, { groupId: 1 });
    expect(built.wireName).toBe('OidbSvcTrpcTcp.0xeac_1');
  });
});

describe('parseOidbResponse', () => {
  it('decodes wire bytes via spec.decode and runs spec.deserialize on the body', () => {
    const sender = makeSender();
    const envBytes = protobuf_encode<OidbBase<OidbGroupReaction>>({
      command: 0x9082, subCommand: 1, body: { type: 7 } as OidbGroupReaction,
    });
    type Echo = { type: number };
    const spec: OidbCallSpec<OidbSender, OidbGroupReaction, OidbGroupReaction, void, Echo> = {
      command: 0x9082, subCommand: 1,
      serialize: () => ({} as OidbGroupReaction),
      deserialize: (_ctx, b) => ({ type: b.type ?? 0 }),
      encode: env => protobuf_encode<OidbBase<OidbGroupReaction>>(env),
      decode: bytes => protobuf_decode<OidbBase<OidbGroupReaction>>(bytes),
    };
    expect(parseOidbResponse(sender, spec, envBytes)).toEqual({ type: 7 });
  });

  it('substitutes empty body when the envelope lacks one', () => {
    const sender = makeSender();
    const envBytes = protobuf_encode<OidbBase<OidbEmpty>>({ command: 0x9082, subCommand: 1 });
    const deserialize = vi.fn(() => ({ ok: true }));
    parseOidbResponse(sender, { ...staticSubSpec, deserialize } as any, envBytes);
    // deserialize now receives (ctx, body) — body is the second arg.
    expect(deserialize.mock.calls[0]![1]).toEqual({});
  });
});

describe('OidbError', () => {
  it('formats message with hex cmd and decimal subcmd', () => {
    const e = new OidbError(123, 'denied', 0x9084, 2);
    expect(e.message).toBe('OIDB error 123 on 0x9084_2: denied');
    expect(e.name).toBe('OidbError');
    expect(e.code).toBe(123);
    expect(e.serverMsg).toBe('denied');
    expect(e.command).toBe(0x9084);
    expect(e.subCommand).toBe(2);
  });
});
