import { describe, it, expect, vi } from 'vitest';

vi.mock('@snowluma/protocol/bridge-oidb', () => ({
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

// element-builder reaches into protoEncode with element-specific schemas
// that we don't want to construct manually in tests; stub it to return
// a benign placeholder.
vi.mock('@snowluma/protocol/element-builder', () => ({
  buildSendElems: vi.fn(async () => []),
}));

import { gunzipSync, gzipSync } from 'zlib';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendLongMsgReq, SendLongMsgResp, LongMsgResult, RecvLongMsgResp } from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { ForwardApi } from '../../src/bridge/apis/forward';
import { mockBridge } from './_helpers';

/** Decode the SsoSendLongMsg packet body back into the per-node contentHead
 *  timestamps of the MultiMsg action — how #209's custom time is verified on
 *  the wire. */
function sentNodeTimestamps(body: Uint8Array): number[] {
  const req = protobuf_decode<SendLongMsgReq>(body);
  const payload = req.info?.payload;
  if (!payload) return [];
  const longMsg = protobuf_decode<LongMsgResult>(gunzipSync(Buffer.from(payload)));
  const main = longMsg.action?.find((a) => a?.actionCommand === 'MultiMsg');
  const bodies = Array.isArray(main?.actionData?.msgBody) ? main!.actionData!.msgBody : [];
  return bodies.map((b) => Number(b.contentHead?.timestamp ?? 0));
}

function uploadResponseWithResId(resId: string) {
  const encoded = protobuf_encode<SendLongMsgResp>({ result: { resId } });
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(encoded),
  };
}

/** Build an SsoRecvLongMsg response wrapping the given forward nodes. */
function recvLongMsgResp(bodies: PushMsgBody[]) {
  const longMsg: LongMsgResult = {
    action: [{ actionCommand: 'MultiMsg', actionData: { msgBody: bodies } }],
  };
  const gz = gzipSync(Buffer.from(protobuf_encode<LongMsgResult>(longMsg)));
  return recvCompressedLongMsgResp(gz);
}

function recvCompressedLongMsgResp(payload: Uint8Array) {
  const resp = protobuf_encode<RecvLongMsgResp>({ result: { payload } });
  return { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.from(resp) };
}

describe('actions/forward', () => {
  it('uploadForwardNodes rejects empty arrays', async () => {
    const bridge = mockBridge();
    await expect(new ForwardApi(bridge as any).upload([]))
      .rejects.toThrow(/required/);
  });

  it('uploadForwardNodes dispatches to SsoSendLongMsg with a non-empty body and returns the res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-001')) as any,
    });

    const resId = await new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'alice', elements: [] },
    ]);

    expect(resId).toBe('res-001');
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd, body] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
    expect((body as Uint8Array).length).toBeGreaterThan(0);
  });

  it('honours a custom per-node time on the wire, and defaults to now when absent (#209)', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-time')) as any,
    });

    const customTime = 1600000000; // 2020-09-13, clearly not "now"
    await new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'alice', elements: [], time: customTime },
      { userUin: 10002, nickname: 'bob', elements: [] }, // no time → fallback
    ]);

    const [, body] = bridge.sendRawPacket.mock.calls[0]!;
    const [tsAlice, tsBob] = sentNodeTimestamps(body as Uint8Array);

    expect(tsAlice).toBe(customTime);
    // Bob falls back to the current time (seconds).
    expect(Math.abs(tsBob - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('uploadForwardNodes throws when sendRawPacket reports failure', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'pipe broken', responseData: null,
      })) as any,
    });
    await expect(new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [] },
    ])).rejects.toThrow(/pipe broken/);
  });

  it('uploadForwardNodes throws when the response is missing res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('')) as any,
    });
    await expect(new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [] },
    ])).rejects.toThrow(/missing res_id/);
  });

  it('cached fetch after upload keeps a usable image source (#441)', async () => {
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId('res-img-cache')) as any;
    const bridge = mockBridge({ sendRawPacket });
    const source = 'https://cdn.example/bot-built.png';

    const resId = await new ForwardApi(bridge as any).upload([
      {
        userUin: 10001,
        nickname: 'alice',
        elements: [{ type: 'image', url: source }],
      },
    ]);
    const fetched = await new ForwardApi(bridge as any).fetch(resId);

    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.elements[0]).toMatchObject({
      type: 'image',
      url: source,
      imageUrl: source,
    });
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
  });

  it('fetchForwardNodes serves from cache after a successful upload (no second sendRawPacket)', async () => {
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId('res-cache')) as any;
    const bridge = mockBridge({ sendRawPacket });

    const nodes = [
      { userUin: 10001, nickname: 'alice', elements: [] },
      { userUin: 10002, nickname: 'bob', elements: [] },
    ];

    const resId = await new ForwardApi(bridge as any).upload(nodes);
    expect(resId).toBe('res-cache');

    const fetched = await new ForwardApi(bridge as any).fetch('res-cache');
    // Same nicknames + uins; elements have been deep-copied so the shape
    // is preserved but the array reference is different.
    expect(fetched).toHaveLength(2);
    expect(fetched.map((n: { nickname: string }) => n.nickname)).toEqual(['alice', 'bob']);
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
  });

  it('[#201] fills a group forward node nickname from grp.groupName when memberName is empty', async () => {
    // Real merged-forward nodes leave grp.memberName (field 2) null and carry the
    // sender display name in grp.memberCard (field 4). Verified on-target: fromUin
    // 1787882683 ↔ grp.memberCard "墨梓柒". Before the fix the node nickname came
    // back "" and enrichSenders 0x899-AUTHORITY_FAIL'd on the placeholder group.
    const node: PushMsgBody = {
      responseHead: { fromUin: 1787882683, fromUid: 'u_x', grp: { groupUin: 284840486, memberCard: '墨梓柒' } },
      contentHead: { msgType: 82, sequence: 1, timestamp: 100 }, // 82 = PkgType.GroupMessage
      body: { richText: { elems: [{ text: { str: 'hi' } }] } },
    };
    const bridge = mockBridge({ sendRawPacket: vi.fn(async () => recvLongMsgResp([node])) as any });
    const nodes = await new ForwardApi(bridge as any).fetch('res-201');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.userUin).toBe(1787882683);
    expect(nodes[0]!.nickname).toBe('墨梓柒'); // was '' before the fix
    expect(nodes[0]!.groupId).toBe(284840486);
    // The nickname is present, so no group-member-list enrichment fetch fires.
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(1);
  });

  it('fetchForwardNodes throws on transport failure when nothing is cached', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'down', responseData: null,
      })) as any,
    });
    await expect(new ForwardApi(bridge as any).fetch('cold-cache-miss'))
      .rejects.toThrow(/download forward message failed|down/);
  });

  it('bounds long-message gunzip output and reports decompression context', async () => {
    // This is one byte beyond the production 32 MiB ceiling but compresses to
    // a small response, modelling an otherwise cheap gzip bomb from QQ.
    const expandedBytes = (32 * 1024 * 1024) + 1;
    const payload = gzipSync(Buffer.alloc(expandedBytes, 0x61));
    const resId = 'oversized-compressed-forward';
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => recvCompressedLongMsgResp(payload)) as any,
    });

    await expect(new ForwardApi(bridge as any).fetch(resId)).rejects.toThrow(
      /download forward message decompression failed .*res_id=oversized-compressed-forward.*max_output_bytes=33554432/,
    );
  });

  it('uploadForwardNodes recursively uploads nested innerForward chains (NapCat piggyback model)', async () => {
    // Regression: nested forward needs the inner chain to be uploaded
    // first (so we have its res_id for the outer ARK preview), AND
    // the inner level's msgBody to be carried up to the outermost
    // long-msg upload as an extra `actionCommand` slot keyed on a
    // uuid. Matches `dev/NapCatQQ/.../SendMsg.uploadForwardedNodesPacket`
    // — the receiver gets the whole tree from a single fetch instead
    // of resolving each layer's res_id separately.
    const responses = ['inner-res', 'outer-res'];
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId(responses.shift()!)) as any;
    const bridge = mockBridge({ sendRawPacket });

    const resId = await new ForwardApi(bridge as any).upload([
      {
        userUin: 111,
        nickname: 'outer',
        elements: [],
        innerForward: [
          { userUin: 222, nickname: 'inner', elements: [{ type: 'text', text: 'hi' }] },
        ],
      },
    ]);

    // Two server roundtrips: one for the inner chain, then one for
    // the outer (which piggybacks the inner msgBody onto its actions
    // array). The outer res_id is what the caller gets back.
    expect(resId).toBe('outer-res');
    expect(sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('uploadForwardNodes leaves flat (non-nested) sends at a single roundtrip', async () => {
    // Backwards-compat: the common case (no inner forward) must still
    // be one SsoSendLongMsg call. Without this we'd double upload
    // every regular forward send.
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId('flat-res')) as any;
    const bridge = mockBridge({ sendRawPacket });

    const resId = await new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [{ type: 'text', text: 'hello' }] },
      { userUin: 10002, nickname: 'b', elements: [{ type: 'text', text: 'world' }] },
    ]);

    expect(resId).toBe('flat-res');
    expect(sendRawPacket).toHaveBeenCalledOnce();
  });
});

describe('actions/forward — sender name enrichment (#174)', () => {
  function apiWith(contacts: { fetchGroupMemberList: any; fetchUserProfile: any }) {
    return new ForwardApi({ apis: { contacts } } as any);
  }

  it('fills empty / "QQ用户" names via the group member list (L3), card preferred', async () => {
    const fetchGroupMemberList = vi.fn(async () => [
      { uin: 10001, nickname: 'AliceNick', card: 'AliceCard' },
      { uin: 10002, nickname: 'BobNick', card: '' },
    ]);
    const fetchUserProfile = vi.fn(async (uin: number) => ({ uin, nickname: 'Stranger' }));
    const api = apiWith({ fetchGroupMemberList, fetchUserProfile });

    const nodes: any[] = [
      { userUin: 10001, nickname: '', groupId: 700, messageType: 'group', elements: [] },
      { userUin: 10002, nickname: 'QQ用户', groupId: 700, messageType: 'group', elements: [] },
      { userUin: 10003, nickname: '', groupId: 700, messageType: 'group', elements: [] }, // not in list
      { userUin: 10009, nickname: '', messageType: 'private', elements: [] },             // private
      { userUin: 10005, nickname: 'KeepMe', groupId: 700, messageType: 'group', elements: [] },
    ];
    const changed = await (api as any).enrichSenders(nodes);

    expect(changed).toBe(true);
    expect(nodes[0].nickname).toBe('AliceCard');     // card preferred over nick
    expect(nodes[0].senderCard).toBe('AliceCard');
    expect(nodes[1].nickname).toBe('BobNick');       // card empty → nickname
    expect(nodes[2].nickname).toBe('Stranger');      // not in member list → L4 profile
    expect(nodes[3].nickname).toBe('Stranger');      // private node → L4 profile
    expect(nodes[4].nickname).toBe('KeepMe');        // already named → untouched
    expect(fetchGroupMemberList).toHaveBeenCalledTimes(1); // one fetch covers the whole group
  });

  it('is a no-op (no fetch) when every node already has a name', async () => {
    const fetchGroupMemberList = vi.fn();
    const fetchUserProfile = vi.fn();
    const api = apiWith({ fetchGroupMemberList, fetchUserProfile });
    const nodes: any[] = [{ userUin: 1, nickname: 'has-name', groupId: 7, messageType: 'group', elements: [] }];
    expect(await (api as any).enrichSenders(nodes)).toBe(false);
    expect(fetchGroupMemberList).not.toHaveBeenCalled();
  });

  it('keeps the placeholder and never throws when resolution fails', async () => {
    const api = apiWith({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net down'); }),
      fetchUserProfile: vi.fn(async () => { throw new Error('net down'); }),
    });
    const nodes: any[] = [{ userUin: 10001, nickname: 'QQ用户', groupId: 700, messageType: 'group', elements: [] }];
    await expect((api as any).enrichSenders(nodes)).resolves.toBe(false);
    expect(nodes[0].nickname).toBe('QQ用户');
  });

  it('does NOT fan a member-list failure out to per-uin profile lookups (rate-limit guard)', async () => {
    const fetchUserProfile = vi.fn(async (uin: number) => ({ uin, nickname: 'X' }));
    const api = apiWith({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net'); }),
      fetchUserProfile,
    });
    // 5 distinct group senders whose member list errors → must keep placeholder,
    // NOT trigger 5 profile calls.
    const nodes: any[] = Array.from({ length: 5 }, (_, i) => ({
      userUin: 20000 + i, nickname: '', groupId: 700, messageType: 'group', elements: [],
    }));
    expect(await (api as any).enrichSenders(nodes)).toBe(false);
    expect(fetchUserProfile).not.toHaveBeenCalled();
    expect(nodes.every((n) => n.nickname === '')).toBe(true);
  });
});
