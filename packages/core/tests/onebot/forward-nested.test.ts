// Regression coverage for nested forward (forward-inside-forward).
//
// Bug being pinned: when a custom forward node's `content` is itself
// a list of `{type:'node'}` entries (a forward chain inside a forward
// chain), the parser used to call `parseMessage(content, false)`
// which routes each inner node through `message-parser.ts:217 case
// 'node':`. That case JSON-stringifies `content` into the
// `resId` field of a `MessageElement{type:'node'}` placeholder —
// which `element-builder.buildSendElems` then silently drops at its
// default case. End result: the outer forward goes out with an empty
// (or text-only) body, the nested chain is lost.
//
// Fix:`parseForwardNodes` now detects an all-node content array,
// recursively builds the inner ForwardNodePayload[], uploads it as a
// separate forward to obtain a `res_id`, then embeds an ARK preview
// element (`{type:'forward', resId}`) in the outer node — which is
// exactly the shape `element-builder.makeForwardElem` already knows
// how to render. Matches NapCat's `uploadForwardedNodesPacket`
// recursion (capped at 3 levels deep).

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
  it('group: nested forward uploads inner chain first, outer embeds ARK preview pointing at it', async () => {
    const uploadForwardNodes = vi.fn(async (nodes: any[]) => {
      // Inner gets uploaded before outer; track the order by inspecting
      // the elements shape. The inner chain's payload is a plain text
      // node; the outer chain's only element is a `forward` ARK preview
      // referencing the inner res_id we returned just before.
      const innerNode = nodes[0];
      const onlyElem = innerNode.elements[0];
      if (onlyElem.type === 'text' && onlyElem.text === 'hello from inner') {
        return 'INNER_RESID';
      }
      if (onlyElem.type === 'forward' && onlyElem.resId === 'INNER_RESID') {
        return 'OUTER_RESID';
      }
      throw new Error(`unexpected upload payload: ${JSON.stringify(nodes)}`);
    });
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ uploadForwardNodes, sendGroupMessage } as any);
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

    // Two uploads: inner first, then outer.
    expect(uploadForwardNodes).toHaveBeenCalledTimes(2);

    // Inner upload: nodes[0] is the leaf node, scoped to the outer group.
    const [innerNodes, innerGroupId] = uploadForwardNodes.mock.calls[0]!;
    expect(innerGroupId).toBe(12345);
    expect((innerNodes as any[])[0]!.userUin).toBe(222);
    expect((innerNodes as any[])[0]!.elements).toEqual([{ type: 'text', text: 'hello from inner' }]);

    // Outer upload: the wrapper node carries a single `forward` ARK
    // preview element that points at the inner res_id we minted above.
    const [outerNodes, outerGroupId] = uploadForwardNodes.mock.calls[1]!;
    expect(outerGroupId).toBe(12345);
    expect((outerNodes as any[])[0]!.userUin).toBe(111);
    expect((outerNodes as any[])[0]!.elements).toHaveLength(1);
    expect((outerNodes as any[])[0]!.elements[0]).toMatchObject({
      type: 'forward',
      resId: 'INNER_RESID',
    });

    expect(result.forwardId).toBe('OUTER_RESID');
    expect(sendGroupMessage).toHaveBeenCalledOnce();
  });

  it('private: nested forward threads userId into inner uploadForwardNodes', async () => {
    // Same shape but routed via sendPrivateForwardMessage. The c2c path
    // passes `userId` instead of `groupId` so any inner image/record
    // uploads can pick up the recipient's UID scene (otherwise the
    // OIDB private-media upload has no target uid).
    const uploadForwardNodes = vi.fn(async () => 'RESID');
    const sendPrivateMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
    }));

    const bridge = fakeBridge({ uploadForwardNodes, sendPrivateMessage } as any);
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

    // Inner upload: groupId undefined, userId is the c2c recipient.
    const innerCall = uploadForwardNodes.mock.calls[0]!;
    expect(innerCall[1]).toBeUndefined();
    expect(innerCall[2]).toBe(67890);
  });

  it('rejects nesting deeper than 3 levels', async () => {
    // Build a 4-level nested chain. NapCat caps at 3 too, going further
    // wastes long-msg uploads and risks one inner upload timing out
    // and aborting the whole tree. Better to fail loud here.
    const uploadForwardNodes = vi.fn(async () => 'X');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ uploadForwardNodes, sendGroupMessage } as any);
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
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ uploadForwardNodes, sendGroupMessage } as any);
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
    const uploadForwardNodes = vi.fn(async () => 'RES');
    const sendGroupMessage = vi.fn(async () => ({
      messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 0,
    }));
    const bridge = fakeBridge({ uploadForwardNodes, sendGroupMessage } as any);
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
