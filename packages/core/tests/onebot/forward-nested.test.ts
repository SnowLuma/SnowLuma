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
import type { OneBotInstanceContext } from '../../src/onebot/instance-context';
import {
  sendGroupForwardMessage,
  sendPrivateForwardMessage,
} from '../../src/onebot/modules/message-actions';

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

    const bridge = fakeBridge({ uploadForwardNodes, apis: { message: { sendGroup: sendGroupMessage } } } as any);
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

  it('private: nested forward threads userId into uploadForwardNodes', async () => {
    // Same shape but routed via sendPrivateForwardMessage. The c2c path
    // passes `userId` instead of `groupId` so the upload pipeline can
    // pick up the recipient's UID scene for any inner media element.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RESID');
    const sendPrivateMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ uploadForwardNodes, apis: { message: { sendPrivate: sendPrivateMessage } } } as any);
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
    const bridge = fakeBridge({ uploadForwardNodes, apis: { message: { sendGroup: sendGroupMessage } } } as any);
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
    const bridge = fakeBridge({ uploadForwardNodes, apis: { message: { sendGroup: sendGroupMessage } } } as any);
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

  it('mixed content (some {type:"node"} + non-node) falls back to flat parsing — does NOT recurse', async () => {
    // Recursion only kicks in when *all* content entries are nodes —
    // mixed content is ambiguous (do the non-node parts belong to the
    // outer node or are they parallel siblings?), so we keep the legacy
    // behaviour and let parseMessage handle it. Non-node parts come
    // through, node parts get parsed via `case 'node':` and then
    // dropped by element-builder. A user who wants nested forward
    // should pass a pure node list.
    const uploadForwardNodes = vi.fn(async (_nodes: any[], _groupId?: number, _userId?: number) => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ uploadForwardNodes, apis: { message: { sendGroup: sendGroupMessage } } } as any);
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

    await sendGroupForwardMessage(ctx, 12345, messages as any);
    expect(uploadForwardNodes).toHaveBeenCalledOnce();
    // Only the text element survives — the legacy "node MessageElement"
    // that parseMessage produces is opaque to the element-builder.
    const [nodes] = uploadForwardNodes.mock.calls[0]!;
    const elements = (nodes as any[])[0]!.elements;
    expect(elements.some((e: any) => e.type === 'text' && e.text === 'a sibling')).toBe(true);
  });
});
