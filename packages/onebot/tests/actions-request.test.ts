import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { ACTION_GROUPS } from '../src/actions';

// Load through the registry so `request.ts` → `api-handler` → `actions/index`
// finishes compiling before we read the request specs. Importing `./request`
// first leaves `group.actions` undefined in that cycle.
const requestGroup = ACTION_GROUPS.find((group) => group.category === '请求');
if (!requestGroup) throw new Error('request action group missing');
const actions = requestGroup.actions;

const setFriendAddRequest = actions.find((action) => action.names[0] === 'set_friend_add_request');
const setGroupAddRequest = actions.find((action) => action.names[0] === 'set_group_add_request');
if (!setFriendAddRequest) throw new Error('set_friend_add_request action missing');
if (!setGroupAddRequest) throw new Error('set_group_add_request action missing');

function friendCtx(handleRequest = vi.fn(async () => {})): {
  ctx: ApiActionContext;
  handleRequest: ReturnType<typeof vi.fn>;
} {
  return {
    handleRequest,
    ctx: {
      bridge: { apis: { friend: { handleRequest } } },
    } as unknown as ApiActionContext,
  };
}

function groupCtx(handleGroupRequest = vi.fn(async () => {})): {
  ctx: ApiActionContext;
  handleGroupRequest: ReturnType<typeof vi.fn>;
} {
  return {
    handleGroupRequest,
    ctx: { handleGroupRequest } as unknown as ApiActionContext,
  };
}

describe('onebot/actions/request', () => {
  it('exports the two request actions in authored order', () => {
    expect(actions.map((action) => [...action.names])).toEqual([
      ['set_friend_add_request'],
      ['set_group_add_request'],
    ]);
    expect(actions.map((action) => action.kind)).toEqual(['normal', 'normal']);
  });
});

describe('set_friend_add_request parse', () => {
  it('requires a non-empty flag and defaults approve to true', () => {
    expect(setFriendAddRequest.parse({ flag: 'flag-friend-7' })).toEqual({
      ok: true,
      value: { flag: 'flag-friend-7', approve: true },
    });
  });

  it('stringifies a numeric flag and keeps an explicit approve', () => {
    expect(setFriendAddRequest.parse({ flag: 261237407, approve: false })).toEqual({
      ok: true,
      value: { flag: '261237407', approve: false },
    });
  });

  it('stringifies a boolean flag', () => {
    expect(setFriendAddRequest.parse({ flag: true, approve: true })).toEqual({
      ok: true,
      value: { flag: 'true', approve: true },
    });
  });

  it('drops undeclared keys such as remark', () => {
    expect(setFriendAddRequest.parse({
      flag: 'flag-friend-7',
      approve: true,
      remark: 'buddy',
    })).toEqual({
      ok: true,
      value: { flag: 'flag-friend-7', approve: true },
    });
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [-3, true],
    ['true', true],
    ['FALSE', false],
    [' 1 ', true],
    ['0', false],
    ['yes', true],
    ['NO', false],
    ['on', true],
    ['off', false],
  ] as const)('coerces approve %j to %s', (approve, expected) => {
    expect(setFriendAddRequest.parse({ flag: 'flag-friend-7', approve })).toEqual({
      ok: true,
      value: { flag: 'flag-friend-7', approve: expected },
    });
  });

  it('rejects a missing flag', () => {
    expect(setFriendAddRequest.parse({})).toEqual({
      ok: false,
      field: 'flag',
      reason: 'is required',
    });
  });

  it('rejects an empty flag', () => {
    expect(setFriendAddRequest.parse({ flag: '' })).toEqual({
      ok: false,
      field: 'flag',
      reason: 'must not be empty',
    });
  });

  it('rejects a non-stringifiable flag', () => {
    expect(setFriendAddRequest.parse({ flag: { id: 1 } })).toEqual({
      ok: false,
      field: 'flag',
      reason: 'expected a string',
    });
  });

  it('rejects a null flag', () => {
    expect(setFriendAddRequest.parse({ flag: null })).toEqual({
      ok: false,
      field: 'flag',
      reason: 'expected a string',
    });
  });

  it('rejects an unrecognised approve synonym', () => {
    expect(setFriendAddRequest.parse({ flag: 'flag-friend-7', approve: 'maybe' })).toEqual({
      ok: false,
      field: 'approve',
      reason: 'expected a boolean',
    });
  });
});

describe('set_friend_add_request toHandler', () => {
  it('forwards the flag and default approve, returning an empty ok payload', async () => {
    const { ctx, handleRequest } = friendCtx();

    await expect(setFriendAddRequest.toHandler(ctx)({ flag: 'flag-friend-7' }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleRequest.mock.calls).toEqual([['flag-friend-7', true]]);
  });

  it('forwards an explicit rejection and ignores remark', async () => {
    const { ctx, handleRequest } = friendCtx();

    await expect(setFriendAddRequest.toHandler(ctx)({
      flag: 'u_abc',
      approve: false,
      remark: 'buddy',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleRequest.mock.calls).toEqual([['u_abc', false]]);
  });

  it('stringifies a numeric flag before calling the friend API', async () => {
    const { ctx, handleRequest } = friendCtx();

    await expect(setFriendAddRequest.toHandler(ctx)({ flag: 10001, approve: 'yes' }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleRequest.mock.calls).toEqual([['10001', true]]);
  });

  it('returns BAD_REQUEST for an empty flag without calling the friend API', async () => {
    const { ctx, handleRequest } = friendCtx();

    await expect(setFriendAddRequest.toHandler(ctx)({ flag: '' }))
      .resolves.toEqual({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: 'flag: must not be empty',
      });

    expect(handleRequest).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST naming a missing flag', async () => {
    const { ctx, handleRequest } = friendCtx();

    await expect(setFriendAddRequest.toHandler(ctx)({}))
      .resolves.toEqual({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: 'flag: is required',
      });

    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe('set_friend_add_request describe', () => {
  it('documents the friend-request params and input schema', () => {
    const doc = setFriendAddRequest.describe();

    expect(doc.name).toBe('set_friend_add_request');
    expect(doc.aliases).toEqual([]);
    expect(doc.summary).toBe('处理好友添加请求');
    expect(doc.readOnly).toBe(false);
    expect(doc.returns).toBeUndefined();
    expect(doc.returnsSchema).toBeUndefined();
    expect(doc.stream).toBeUndefined();
    expect(doc.invariants).toEqual([]);
    expect(doc.params).toEqual([
      {
        name: 'flag',
        type: 'string',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'approve',
        type: 'bool',
        required: false,
        default: true,
        schema: { type: 'boolean' },
      },
    ]);
    expect(doc.inputSchema).toEqual({
      type: 'object',
      properties: {
        flag: { type: 'string', minLength: 1 },
        approve: { type: 'boolean', default: true },
      },
      required: ['flag'],
      additionalProperties: true,
    });
  });
});

describe('set_group_add_request parse', () => {
  it('requires flag and defaults approve, reason, and the raw type fields', () => {
    expect(setGroupAddRequest.parse({ flag: 'slreq:1:123456:999:22:1' })).toEqual({
      ok: true,
      value: {
        flag: 'slreq:1:123456:999:22:1',
        sub_type: undefined,
        type: undefined,
        approve: true,
        reason: '',
      },
    });
  });

  it('keeps raw sub_type and type values without coercing them', () => {
    expect(setGroupAddRequest.parse({
      flag: 'flag-group-9',
      sub_type: { kind: 'invite' },
      type: [1, 2],
      approve: 0,
      reason: 404,
    })).toEqual({
      ok: true,
      value: {
        flag: 'flag-group-9',
        sub_type: { kind: 'invite' },
        type: [1, 2],
        approve: false,
        reason: '404',
      },
    });
  });

  it('stringifies a numeric flag and a boolean reason', () => {
    expect(setGroupAddRequest.parse({
      flag: 261237407,
      sub_type: 'add',
      type: 'invite',
      approve: 'off',
      reason: true,
    })).toEqual({
      ok: true,
      value: {
        flag: '261237407',
        sub_type: 'add',
        type: 'invite',
        approve: false,
        reason: 'true',
      },
    });
  });

  it('accepts an explicit empty reason', () => {
    expect(setGroupAddRequest.parse({
      flag: 'invite:999:u_i',
      reason: '',
    })).toEqual({
      ok: true,
      value: {
        flag: 'invite:999:u_i',
        sub_type: undefined,
        type: undefined,
        approve: true,
        reason: '',
      },
    });
  });

  it('rejects a missing flag', () => {
    expect(setGroupAddRequest.parse({ sub_type: 'add' })).toEqual({
      ok: false,
      field: 'flag',
      reason: 'is required',
    });
  });

  it('rejects an empty flag', () => {
    expect(setGroupAddRequest.parse({ flag: '' })).toEqual({
      ok: false,
      field: 'flag',
      reason: 'must not be empty',
    });
  });

  it('rejects a non-string reason', () => {
    expect(setGroupAddRequest.parse({ flag: 'flag-group-9', reason: { text: 'no' } })).toEqual({
      ok: false,
      field: 'reason',
      reason: 'expected a string',
    });
  });

  it('rejects a null reason', () => {
    expect(setGroupAddRequest.parse({ flag: 'flag-group-9', reason: null })).toEqual({
      ok: false,
      field: 'reason',
      reason: 'expected a string',
    });
  });
});

describe('set_group_add_request toHandler', () => {
  it('defaults sub_type to add, approve to true, and reason to empty', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({ flag: 'slreq:1:123456:999:22:1' }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['slreq:1:123456:999:22:1', 'add', true, ''],
    ]);
  });

  it('prefers a present sub_type over type', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'flag-group-9',
      sub_type: 'invite',
      type: 'add',
      approve: false,
      reason: 'no',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['flag-group-9', 'invite', false, 'no'],
    ]);
  });

  it('falls back from a missing sub_type to type', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'add:999:u_t',
      type: 'add',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['add:999:u_t', 'add', true, ''],
    ]);
  });

  it('keeps an empty-string sub_type instead of falling back to type', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'flag-group-9',
      sub_type: '',
      type: 'invite',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['flag-group-9', '', true, ''],
    ]);
  });

  it.each([
    [{ sub_type: 2, type: 'add' }, '2'],
    [{ sub_type: 0 }, '0'],
    [{ sub_type: true, type: 'add' }, 'true'],
    [{ sub_type: false }, 'false'],
    [{ type: 8 }, '8'],
    [{ type: false }, 'false'],
    [{ type: '' }, ''],
  ] as const)('stringifies a primitive locator %j as %s', async (params, subType) => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'flag-group-9',
      ...params,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['flag-group-9', subType, true, ''],
    ]);
  });

  it.each([
    [{ sub_type: { kind: 'invite' }, type: 'invite' }, 'invite'],
    [{ sub_type: ['invite'], type: 'add' }, 'add'],
    [{ sub_type: null, type: 'invite' }, 'invite'],
    [{ sub_type: null, type: null }, 'add'],
    [{ type: { kind: 'add' } }, 'add'],
    [{ type: null }, 'add'],
  ])('falls through a non-primitive locator %j to %s', async (params, subType) => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'flag-group-9',
      ...params,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['flag-group-9', subType, true, ''],
    ]);
  });

  it('stringifies a numeric flag and reason', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 55,
      sub_type: 'add',
      approve: 'no',
      reason: 0,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(handleGroupRequest.mock.calls).toEqual([
      ['55', 'add', false, '0'],
    ]);
  });

  it('returns BAD_REQUEST for an empty flag without handling the group request', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({ flag: '', sub_type: 'add' }))
      .resolves.toEqual({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: 'flag: must not be empty',
      });

    expect(handleGroupRequest).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST for a non-string reason without handling the group request', async () => {
    const { ctx, handleGroupRequest } = groupCtx();

    await expect(setGroupAddRequest.toHandler(ctx)({
      flag: 'flag-group-9',
      reason: ['no'],
    })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'reason: expected a string',
    });

    expect(handleGroupRequest).not.toHaveBeenCalled();
  });
});

describe('set_group_add_request describe', () => {
  it('documents the group-request params including raw type fields', () => {
    const doc = setGroupAddRequest.describe();

    expect(doc.name).toBe('set_group_add_request');
    expect(doc.aliases).toEqual([]);
    expect(doc.summary).toBe('处理加群请求');
    expect(doc.readOnly).toBe(false);
    expect(doc.returns).toBeUndefined();
    expect(doc.returnsSchema).toBeUndefined();
    expect(doc.stream).toBeUndefined();
    expect(doc.invariants).toEqual([]);
    expect(doc.params).toEqual([
      {
        name: 'flag',
        type: 'string',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
      {
        name: 'sub_type',
        type: 'raw',
        required: false,
        default: undefined,
        schema: {},
      },
      {
        name: 'type',
        type: 'raw',
        required: false,
        default: undefined,
        schema: {},
      },
      {
        name: 'approve',
        type: 'bool',
        required: false,
        default: true,
        schema: { type: 'boolean' },
      },
      {
        name: 'reason',
        type: 'string',
        required: false,
        default: '',
        schema: { type: 'string' },
      },
    ]);
    expect(doc.inputSchema).toEqual({
      type: 'object',
      properties: {
        flag: { type: 'string', minLength: 1 },
        sub_type: {},
        type: {},
        approve: { type: 'boolean', default: true },
        reason: { type: 'string', default: '' },
      },
      required: ['flag'],
      additionalProperties: true,
    });
  });
});
