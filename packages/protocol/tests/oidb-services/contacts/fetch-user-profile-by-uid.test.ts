import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbUserInfoByUidRequest, OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchUserProfileByUid } from '../../../src/oidb-services/contacts/fetch-user-profile-by-uid';

function makeSender(body?: OidbUserInfoResponse) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbUserInfoResponse>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchUserProfileByUid namespace (UID form)', () => {
  it('declares 0xFE1_2 WITHOUT uinForm (reserved stays 0)', () => {
    expect(FetchUserProfileByUid.command).toBe(0xFE1);
    expect(FetchUserProfileByUid.subCommand).toBe(2);
    // No `uinForm` exposed — matches Lagrange's isUid=false path on
    // the UID variant. Important because the server distinguishes
    // UIN vs UID requests via the envelope's `reserved` field.
    expect((FetchUserProfileByUid as any).uinForm).toBeUndefined();
  });

  it('packages the uid as field 1 (string), routes to OidbSvcTrpcTcp.0xfe1_2', async () => {
    const sender = makeSender({ body: { uin: 950929451, uid: 'u_abc' } as any });
    await FetchUserProfileByUid.invoke(sender, { uid: 'u_abc' });
    const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0xfe1_2');
    const env = protobuf_decode<OidbBase<OidbUserInfoByUidRequest>>(bytes);
    expect(env.body?.uid).toBe('u_abc');
    // reserved=0 (default, omitted on wire) because this is the UID
    // variant — Lagrange's `OidbSvcTrpcTcp0xFE1_2.cs:9` does the same.
    expect(env.reserved ?? 0).toBe(0);
  });

  it('requests the same property key catalogue as the UIN variant', async () => {
    const sender = makeSender({ body: { uin: 1, uid: 'u' } as any });
    await FetchUserProfileByUid.invoke(sender, { uid: 'u' });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbUserInfoByUidRequest>>(bytes);
    const keys = env.body?.keys?.map(k => k.key);
    expect(keys).toContain(20002); // nickname — the whole point
    expect(keys).toContain(105);   // QQ level
  });

  it('decodes nickname + uin from the response so the pipeline can fill them into the event', async () => {
    // This is the actual point of the namespace — the stranger's
    // nickname + uin lands here so the pipeline can patch them onto
    // the in-flight group_invite event.
    const enc = (s: string) => new TextEncoder().encode(s);
    const sender = makeSender({
      body: {
        uin: 950929451, uid: 'u_abc',
        properties: {
          bytesProperties: [{ code: 20002, value: enc('小明') }],
          numberProperties: [],
        },
      } as any,
    });
    const out = await FetchUserProfileByUid.invoke(sender, { uid: 'u_abc' });
    expect(out.uin).toBe(950929451);
    expect(out.nickname).toBe('小明');
  });

  it('throws when the response body is missing entirely', async () => {
    const sender = makeSender({});
    await expect(FetchUserProfileByUid.invoke(sender, { uid: 'u_abc' }))
      .rejects.toThrow('user info response body missing');
  });
});
