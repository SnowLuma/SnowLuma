// Regression coverage for nested forward (forward-inside-forward).
//
// `parseForwardNodes` detects an all-`{type:'node'}` content array,
// recursively builds the inner `ForwardNodePayload[]`, and attaches it
// to the outer node as `innerForward`. `uploadForwardNodes` then drives
// the recursive long-msg upload + ARK-preview generation + msgBody
// piggyback in one pass over the tree — modelled on NapCat's
// `uploadForwardedNodesPacket` (`dev/NapCatQQ/.../SendMsg.ts:208`).
//
// These tests stub `bridge.uploadForwardNodes` so we can inspect the
// payload that the upload pipeline receives: outer nodes carry an
// `innerForward` field holding the parsed inner chain, and the
// upload helper is invoked exactly ONCE (the recursive walk happens
// inside the real implementation; mocks see only the top call).

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import {
  forwardSingleMessage,
  sendGroupForwardMessage,
  sendPrivateForwardMessage,
} from '../src/modules/message-actions';

function fakeBridge(overrides: Partial<BridgeInterface> = {}): BridgeInterface {
  return new Proxy(overrides as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

function makeCtx(bridge: BridgeInterface): OneBotInstanceContext {
  return {
    uin: '10001',
    selfId: 10001,
    bridge,
    messageStore: { findEvent: () => null } as any,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as any,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('forward — nested {type:"node"} content', () => {
  it('group: nested forward attaches inner chain to outer node via `innerForward`', async () => {
    // Single upload call, but the outer payload now carries an
    // `innerForward` field with the recursively-parsed inner chain.
    // The real `uploadForwardNodes` (the production module) walks
    // that tree and does the recursive long-msg uploads with NapCat
    // piggyback — we're just testing the parse-side handoff here.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'OUTER_RESID');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [{
      type: 'node',
      data: {
        user_id: 111, nickname: 'outer',
        content: [{
          type: 'node',
          data: {
            user_id: 222, nickname: 'inner',
            content: [{ type: 'text', data: { text: 'hello from inner' } }],
          },
        }],
      },
    }];

    const result = await sendGroupForwardMessage(ctx, 12345, messages as any);

    // Exactly one upload call: the production-side recursive walker
    // owns the inner upload, the OneBot parser just hands off the tree.
    expect(uploadForwardNodes).toHaveBeenCalledOnce();

    const [outerNodes, outerGroupId] = uploadForwardNodes.mock.calls[0]!;
    expect(outerGroupId).toBe(12345);
    const outerNode = (outerNodes as any[])[0]!;
    expect(outerNode.userUin).toBe(111);
    // Outer node's `elements` is empty — the upload pipeline replaces
    // it with the real ARK preview once it has the inner res_id.
    expect(outerNode.elements).toEqual([]);
    // The inner chain rides along as `innerForward`.
    expect(Array.isArray(outerNode.innerForward)).toBe(true);
    expect(outerNode.innerForward).toHaveLength(1);
    expect(outerNode.innerForward[0]).toMatchObject({
      userUin: 222,
      nickname: 'inner',
      elements: [{ type: 'text', text: 'hello from inner' }],
    });

    expect(result.forwardId).toBe('OUTER_RESID');
    expect(sendGroupMessage).toHaveBeenCalledOnce();
  });

  it('threads an explicit data.time onto the node payload, leaving absent ones for the default (#209)', async () => {
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RESID');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [
      { type: 'node', data: { user_id: 111, nickname: 'a', time: 1600000000, content: [{ type: 'text', data: { text: 'hi' } }] } },
      { type: 'node', data: { user_id: 222, nickname: 'b', content: [{ type: 'text', data: { text: 'yo' } }] } },
      { type: 'node', data: { user_id: 333, nickname: 'c', time: 1700000000000, content: [{ type: 'text', data: { text: 'ms' } }] } }, // ms → out of uint32 range
      { type: 'node', data: { user_id: 444, nickname: 'd', time: -5, content: [{ type: 'text', data: { text: 'neg' } }] } },
    ];

    await sendGroupForwardMessage(ctx, 12345, messages as any);

    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    expect((nodes as any[])[0].time).toBe(1600000000); // explicit seconds carried through
    expect((nodes as any[])[1].time).toBeUndefined();   // absent → default to now
    expect((nodes as any[])[2].time).toBeUndefined();   // millisecond input rejected (uint32 overflow guard)
    expect((nodes as any[])[3].time).toBeUndefined();   // negative rejected → default to now
  });

  it('private: nested forward threads userId into uploadForwardNodes', async () => {
    // Same shape but routed via sendPrivateForwardMessage. The c2c path
    // passes `userId` instead of `groupId` so the upload pipeline can
    // pick up the recipient's UID scene for any inner media element.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RESID');
    const sendPrivateMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ apis: { message: { sendPrivate: sendPrivateMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [{
      type: 'node',
      data: {
        user_id: 111, nickname: 'outer',
        content: [{
          type: 'node',
          data: {
            user_id: 222, nickname: 'inner',
            content: [{ type: 'text', data: { text: 'hi' } }],
          },
        }],
      },
    }];

    await sendPrivateForwardMessage(ctx, 67890, messages as any);

    // Single call, c2c-scoped (groupId undefined, userId = recipient).
    expect(uploadForwardNodes).toHaveBeenCalledOnce();
    const call = uploadForwardNodes.mock.calls[0]!;
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe(67890);
    // Inner chain attached via `innerForward`.
    const outerNode = (call[0] as any[])[0]!;
    expect(outerNode.innerForward).toHaveLength(1);
    expect(outerNode.innerForward[0]!.userUin).toBe(222);
  });

  it('rejects nesting deeper than 3 levels', async () => {
    // Build a 4-level nested chain. NapCat caps at 3 too, going further
    // wastes long-msg uploads and risks one inner upload timing out
    // and aborting the whole tree. Better to fail loud here.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'X');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    function wrap(content: any, depth: number): any {
      if (depth === 0) return [{ type: 'text', data: { text: 'leaf' } }];
      return [{
        type: 'node',
        data: { user_id: 100 + depth, nickname: `lvl-${depth}`, content: wrap(content, depth - 1) },
      }];
    }

    await expect(
      sendGroupForwardMessage(ctx, 12345, wrap(null, 4) as any),
    ).rejects.toThrow(/depth/);
  });

  it('flat content (no nesting) still goes through the unchanged path', async () => {
    // Backwards-compat: a single-level forward with plain text nodes
    // calls uploadForwardNodes exactly once and never touches the
    // recursive branch.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [
      { type: 'node', data: { user_id: 111, nickname: 'a', content: [{ type: 'text', data: { text: 'one' } }] } },
      { type: 'node', data: { user_id: 222, nickname: 'b', content: [{ type: 'text', data: { text: 'two' } }] } },
    ];

    await sendGroupForwardMessage(ctx, 12345, messages as any);
    expect(uploadForwardNodes).toHaveBeenCalledOnce();
    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    expect((nodes as any[])).toHaveLength(2);
    expect((nodes as any[])[0]!.elements).toEqual([{ type: 'text', text: 'one' }]);
    expect((nodes as any[])[1]!.elements).toEqual([{ type: 'text', text: 'two' }]);
  });

  it('rejects video with hidden siblings before uploading a forward', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendGroupForwardMessage(ctx, 12345, [{
      type: 'node',
      data: {
        user_id: 111,
        nickname: 'mixed-video',
        content: [
          { type: 'video', data: { file: 'https://example.com/video.mp4' } },
          { type: 'text', data: { text: 'must not survive bot forwarding' } },
        ],
      },
    }] as any)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'video',
    });

    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('rejects hidden siblings before forwarding a cached video message', async () => {
    const sendGroupMessage = vi.fn();
    const findVideo = vi.fn();
    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage } } } as any);
    const ctx = makeCtx(bridge);
    (ctx as any).messageStore = {
      findEvent: () => ({
        message: [
          { type: 'video', data: { file: 'cached-video-id' } },
          { type: 'text', data: { text: 'must not survive bot forwarding' } },
        ],
      }),
    };
    (ctx as any).mediaStore = { findVideo };

    await expect(forwardSingleMessage(ctx, 77, { groupId: 12345 }))
      .rejects.toMatchObject({
        code: 'UNSENDABLE_TYPE',
        elementType: 'video',
      });

    expect(findVideo).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('rejects an unknown top-level entry before uploading valid siblings', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);
    const messages = [
      {
        type: 'node',
        data: {
          user_id: 111,
          nickname: 'valid',
          content: [{ type: 'text', data: { text: 'must not upload' } }],
        },
      },
      { type: 'surprise', data: { content: 'silently dropped before' } },
    ];

    await expect(sendGroupForwardMessage(ctx, 12345, messages as any)).rejects.toMatchObject({
      code: 'UNKNOWN_TYPE',
      elementType: 'surprise',
    });
    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('rejects object-valued node metadata before uploading', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendGroupForwardMessage(ctx, 12345, [{
      type: 'node',
      data: {
        user_id: { accidental: 111 },
        nickname: 'invalid',
        content: [{ type: 'text', data: { text: 'must not upload' } }],
      },
    }] as any)).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      elementType: 'node',
      field: 'user_id',
    });
    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('rejects a cached message node with no valid sender instead of dropping it', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);
    (ctx as any).messageStore = {
      findEvent: () => ({
        user_id: 0,
        message_type: 'group',
        message: [{ type: 'text', data: { text: 'cached' } }],
        sender: { nickname: 'missing-id' },
      }),
    };

    await expect(sendGroupForwardMessage(ctx, 12345, [
      { type: 'node', data: { id: 7 } },
      { type: 'node', data: { user_id: 222, content: [{ type: 'text', data: { text: 'sibling' } }] } },
    ] as any)).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      elementType: 'node',
      field: 'user_id',
    });
    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('resolves a cached node by a signed negative OneBot message_id', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 1, clientSequence: 0, random: 1, timestamp: 1,
    }));
    const findEvent = vi.fn((id: number) => id === -123 ? ({
      user_id: 111,
      message_id: -123,
      message_seq: 42,
      message_type: 'group',
      group_id: 12345,
      time: 1700000000,
      message: [{ type: 'text', data: { text: 'cached negative id' } }],
      sender: { nickname: 'alice' },
    }) : null);
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);
    (ctx as any).messageStore = { findEvent };

    await sendGroupForwardMessage(ctx, 12345, [
      { type: 'node', data: { id: -123 } },
    ] as any);

    expect(findEvent).toHaveBeenCalledWith(-123);
    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    expect((nodes as any[])[0]).toMatchObject({
      userUin: 111,
      msgId: -123,
      elements: [{ type: 'text', text: 'cached negative id' }],
    });
  });

  it('[#372] empty group card does not replace a cached sender nickname with the QQ number', async () => {
    // Group events always store sender.card as "" when the member has no
    // card. `??` treats that empty string as present and then
    // `nickname || String(userUin)` collapses the display name to the QQ
    // number — the get_forward_msg symptom in #372.
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 1, clientSequence: 0, random: 1, timestamp: 1,
    }));
    const findEvent = vi.fn((id: number) => id === 7 ? ({
      user_id: 22222,
      message_id: 7,
      message_seq: 42,
      message_type: 'group',
      group_id: 12345,
      time: 1700000000,
      message: [{ type: 'text', data: { text: 'cached' } }],
      sender: { user_id: 22222, nickname: 'alice', card: '' },
    }) : id === 8 ? ({
      user_id: 33333,
      message_id: 8,
      message_seq: 43,
      message_type: 'group',
      group_id: 12345,
      time: 1700000000,
      message: [{ type: 'text', data: { text: 'nameless' } }],
      sender: { user_id: 33333, nickname: '', card: '' },
    }) : null);
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);
    (ctx as any).messageStore = { findEvent };

    await sendGroupForwardMessage(ctx, 12345, [
      { type: 'node', data: { id: 7, nickname: 'node-override' } },
      { type: 'node', data: { id: 8, nickname: 'node-fallback' } },
    ] as any);

    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    expect((nodes as any[])[0]).toMatchObject({ userUin: 22222, nickname: 'alice' });
    expect((nodes as any[])[1]).toMatchObject({ userUin: 33333, nickname: 'node-fallback' });
  });

  it('reports a missing cached message_id as caller-invalid before upload', async () => {
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } },
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendGroupForwardMessage(ctx, 12345, [
      { type: 'node', data: { id: -404 } },
    ] as any)).rejects.toMatchObject({
      code: 'INVALID_FIELD',
      elementType: 'node',
      field: 'message_id',
    });
    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('rejects mixed node/non-node content instead of partially dropping the node', async () => {
    // Recursion only kicks in when *all* content entries are nodes —
    // mixed content is ambiguous (do the non-node parts belong to the
    // outer node or are they parallel siblings?), so we keep the legacy
    // behaviour is ambiguous, so reject it before upload. A user who wants a
    // nested forward must pass a pure node list.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [{
      type: 'node',
      data: {
        user_id: 111, nickname: 'mixed',
        content: [
          { type: 'text', data: { text: 'a sibling' } },
          { type: 'node', data: { user_id: 222, content: [{ type: 'text', data: { text: 'lost' } }] } },
        ],
      },
    }];

    await expect(sendGroupForwardMessage(ctx, 12345, messages as any)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'node',
    });
    expect(uploadForwardNodes).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('[#203] node with user_id "0" or missing falls back to the bot self_id', async () => {
    // Upstream frameworks (AstrBot etc.) send fake forward nodes with
    // user_id "0" or omit it; the protocol端 knows self_id, so default to it
    // instead of rejecting (matches NapCat/LLBot + the core builder).
    const uploadForwardNodes = vi.fn(async (_nodes: any[]) => 'RESID');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));
    const bridge = fakeBridge({ apis: { message: { sendGroup: sendGroupMessage }, forward: { upload: uploadForwardNodes } } } as any);
    const ctx = makeCtx(bridge);

    const messages = [
      { type: 'node', data: { user_id: '0', nickname: 'PixivBot', content: [{ type: 'text', data: { text: 'a' } }] } },
      { type: 'node', data: { nickname: 'PixivBot', content: [{ type: 'text', data: { text: 'b' } }] } }, // user_id omitted
    ];

    await sendGroupForwardMessage(ctx, 12345, messages as any);
    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    expect((nodes as any[])[0].userUin).toBe(10001);       // "0" → self_id
    expect((nodes as any[])[0].nickname).toBe('PixivBot');  // custom nickname preserved
    expect((nodes as any[])[1].userUin).toBe(10001);       // omitted → self_id
  });
});
