import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { actions } from '../src/actions/group-admin';

function requireAction(name: string) {
  const action = actions.find((entry) => entry.names[0] === name);
  if (!action) throw new Error(`${name} action missing`);
  return action;
}

function adminCtx(groupAdmin: Record<string, ReturnType<typeof vi.fn>>): {
  ctx: ApiActionContext;
  groupAdmin: typeof groupAdmin;
} {
  return {
    groupAdmin,
    ctx: { bridge: { apis: { groupAdmin } } } as unknown as ApiActionContext,
  };
}

function portraitCtx(setGroupAvatar = vi.fn(async () => {})): {
  ctx: ApiActionContext;
  setGroupAvatar: ReturnType<typeof vi.fn>;
} {
  return {
    setGroupAvatar,
    ctx: {
      bridge: { apis: { profile: { setGroupAvatar } } },
    } as unknown as ApiActionContext,
  };
}

const setGroupKick = requireAction('set_group_kick');
const setGroupKickMembers = requireAction('set_group_kick_members');
const setGroupBan = requireAction('set_group_ban');
const setGroupWholeBan = requireAction('set_group_whole_ban');
const setGroupAddOption = requireAction('set_group_add_option');
const setGroupSearch = requireAction('set_group_search');
const setGroupMemberInvitePolicy = requireAction('set_group_member_invite_policy');
const setGroupNewMemberHistoryVisibility = requireAction('set_group_new_member_history_visibility');
const setGroupMemberPermissions = requireAction('set_group_member_permissions');
const getGroupAdminSettings = requireAction('get_group_admin_settings');
const setGroupAdmin = requireAction('set_group_admin');
const setGroupCard = requireAction('set_group_card');
const setGroupName = requireAction('set_group_name');
const setGroupLeave = requireAction('set_group_leave');
const setGroupSpecialTitle = requireAction('set_group_special_title');
const setGroupAnonymous = requireAction('set_group_anonymous');
const setGroupAnonymousBan = requireAction('set_group_anonymous_ban');
const setGroupPortrait = requireAction('set_group_portrait');

describe('group admin actions catalog', () => {
  it('exports the public group-admin actions in source order', () => {
    expect(actions.map((action) => [...action.names])).toEqual([
      ['set_group_kick'],
      ['set_group_kick_members'],
      ['set_group_ban'],
      ['set_group_whole_ban'],
      ['set_group_add_option'],
      ['set_group_search'],
      ['set_group_member_invite_policy'],
      ['set_group_new_member_history_visibility'],
      ['set_group_member_permissions'],
      ['get_group_admin_settings'],
      ['set_group_admin'],
      ['set_group_card'],
      ['set_group_name'],
      ['set_group_leave'],
      ['set_group_special_title'],
      ['set_group_anonymous'],
      ['set_group_anonymous_ban'],
      ['set_group_portrait'],
    ]);
    expect(actions.map((action) => action.kind)).toEqual([
      'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal',
      'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal',
      'normal', 'normal', 'normal', 'normal',
    ]);
  });
});

describe('set_group_kick parse', () => {
  it('requires group_id and user_id and defaults reject_add_request to false', () => {
    expect(setGroupKick.parse({ group_id: 314159, user_id: 271828 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, reject_add_request: false },
    });
  });

  it('coerces numeric-string ids and an explicit reject flag', () => {
    expect(setGroupKick.parse({
      group_id: '80001',
      user_id: '24680',
      reject_add_request: 'yes',
    })).toEqual({
      ok: true,
      value: { group_id: 80001, user_id: 24680, reject_add_request: true },
    });
  });

  it('rejects a missing group_id', () => {
    expect(setGroupKick.parse({ user_id: 271828 })).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'is required',
    });
  });

  it('rejects group_id 0 and user_id 0', () => {
    expect(setGroupKick.parse({ group_id: 0, user_id: 271828 })).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'must be >= 1',
    });
    expect(setGroupKick.parse({ group_id: 314159, user_id: 0 })).toEqual({
      ok: false,
      field: 'user_id',
      reason: 'must be >= 1',
    });
  });

  it('rejects an unrecognised reject_add_request synonym', () => {
    expect(setGroupKick.parse({
      group_id: 314159,
      user_id: 271828,
      reject_add_request: 'maybe',
    })).toEqual({
      ok: false,
      field: 'reject_add_request',
      reason: 'expected a boolean',
    });
  });
});

describe('set_group_kick toHandler', () => {
  it('forwards the default reject flag and returns an empty ok payload', async () => {
    const kickMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMember });

    await expect(setGroupKick.toHandler(ctx)({ group_id: 314159, user_id: 271828 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(kickMember.mock.calls).toEqual([[314159, 271828, false]]);
  });

  it('forwards an explicit reject_add_request', async () => {
    const kickMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMember });

    await expect(setGroupKick.toHandler(ctx)({
      group_id: 80002,
      user_id: 30003,
      reject_add_request: 1,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(kickMember.mock.calls).toEqual([[80002, 30003, true]]);
  });

  it('returns BAD_REQUEST for a missing user_id without kicking', async () => {
    const kickMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMember });

    await expect(setGroupKick.toHandler(ctx)({ group_id: 314159 })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'user_id: is required',
    });
    expect(kickMember).not.toHaveBeenCalled();
  });
});

describe('set_group_kick_members parse', () => {
  it('requires a non-empty member-id array and defaults reject_add_request', () => {
    expect(setGroupKickMembers.parse({
      group_id: 888001,
      user_id: [271828, '13579'],
    })).toEqual({
      ok: true,
      value: { group_id: 888001, user_id: [271828, 13579], reject_add_request: false },
    });
  });

  it('keeps an explicit reject_add_request of false', () => {
    expect(setGroupKickMembers.parse({
      group_id: 888001,
      user_id: [24680],
      reject_add_request: false,
    })).toEqual({
      ok: true,
      value: { group_id: 888001, user_id: [24680], reject_add_request: false },
    });
  });

  it('rejects a missing or non-array user_id', () => {
    expect(setGroupKickMembers.parse({ group_id: 888001 })).toEqual({
      ok: false,
      field: 'user_id',
      reason: 'is required',
    });
    expect(setGroupKickMembers.parse({ group_id: 888001, user_id: 271828 })).toEqual({
      ok: false,
      field: 'user_id',
      reason: 'expected an array',
    });
  });

  it('rejects an empty member list and names a bad element index', () => {
    expect(setGroupKickMembers.parse({ group_id: 888001, user_id: [] })).toEqual({
      ok: false,
      field: 'user_id',
      reason: 'must not be empty',
    });
    expect(setGroupKickMembers.parse({ group_id: 888001, user_id: [271828, 0] })).toEqual({
      ok: false,
      field: 'user_id[1]',
      reason: 'must be >= 1',
    });
  });
});

describe('set_group_kick_members toHandler', () => {
  it('forwards the member list and default reject flag', async () => {
    const kickMembers = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMembers });

    await expect(setGroupKickMembers.toHandler(ctx)({
      group_id: 888001,
      user_id: [271828, 13579],
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(kickMembers.mock.calls).toEqual([[888001, [271828, 13579], false]]);
  });

  it('forwards reject_add_request when kicking several members', async () => {
    const kickMembers = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMembers });

    await expect(setGroupKickMembers.toHandler(ctx)({
      group_id: '70001',
      user_id: ['24681'],
      reject_add_request: 'on',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(kickMembers.mock.calls).toEqual([[70001, [24681], true]]);
  });

  it('returns BAD_REQUEST for an empty member list without kicking', async () => {
    const kickMembers = vi.fn(async () => {});
    const { ctx } = adminCtx({ kickMembers });

    await expect(setGroupKickMembers.toHandler(ctx)({
      group_id: 888001,
      user_id: [],
    })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'user_id: must not be empty',
    });
    expect(kickMembers).not.toHaveBeenCalled();
  });
});

describe('set_group_ban parse', () => {
  it('defaults duration to 1800 and keeps a present 0 as unmute', () => {
    expect(setGroupBan.parse({ group_id: 314159, user_id: 271828 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, duration: 1800 },
    });
    expect(setGroupBan.parse({ group_id: 314159, user_id: 271828, duration: 0 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, duration: 0 },
    });
  });

  it('truncates a numeric-string duration', () => {
    expect(setGroupBan.parse({
      group_id: 314159,
      user_id: 271828,
      duration: '600.9',
    })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, duration: 600 },
    });
  });

  it('rejects a negative duration', () => {
    expect(setGroupBan.parse({
      group_id: 314159,
      user_id: 271828,
      duration: -1,
    })).toEqual({
      ok: false,
      field: 'duration',
      reason: 'must be >= 0',
    });
  });
});

describe('set_group_ban toHandler', () => {
  it('mutes with the default duration', async () => {
    const muteMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ muteMember });

    await expect(setGroupBan.toHandler(ctx)({ group_id: 314159, user_id: 271828 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(muteMember.mock.calls).toEqual([[314159, 271828, 1800]]);
  });

  it('forwards duration 0 as unmute', async () => {
    const muteMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ muteMember });

    await expect(setGroupBan.toHandler(ctx)({
      group_id: 80003,
      user_id: 30004,
      duration: 0,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(muteMember.mock.calls).toEqual([[80003, 30004, 0]]);
  });

  it('returns BAD_REQUEST for a negative duration without muting', async () => {
    const muteMember = vi.fn(async () => {});
    const { ctx } = adminCtx({ muteMember });

    await expect(setGroupBan.toHandler(ctx)({
      group_id: 314159,
      user_id: 271828,
      duration: -3,
    })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'duration: must be >= 0',
    });
    expect(muteMember).not.toHaveBeenCalled();
  });
});

describe('set_group_ban describe', () => {
  it('documents the group-user preset and the unmute-capable duration', () => {
    const doc = setGroupBan.describe();

    expect(doc.name).toBe('set_group_ban');
    expect(doc.aliases).toEqual([]);
    expect(doc.summary).toBe('禁言群成员（duration=0 解除）');
    expect(doc.readOnly).toBe(false);
    expect(doc.returns).toBeUndefined();
    expect(doc.returnsSchema).toBeUndefined();
    expect(doc.stream).toBeUndefined();
    expect(doc.invariants).toEqual([]);
    expect(doc.params).toEqual([
      {
        name: 'group_id',
        type: 'uint',
        required: true,
        desc: '群号',
        role: 'group_id',
        schema: { type: 'integer', minimum: 1 },
      },
      {
        name: 'user_id',
        type: 'uint',
        required: true,
        desc: 'QQ 号',
        role: 'member_id',
        schema: { type: 'integer', minimum: 1 },
      },
      {
        name: 'duration',
        type: 'int',
        required: false,
        default: 1800,
        role: 'duration',
        schema: { type: 'integer', minimum: 0 },
      },
    ]);
    expect(doc.inputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
      required: ['group_id', 'user_id'],
      properties: {
        group_id: {
          type: 'integer',
          minimum: 1,
          description: '群号',
          'x-role': 'group_id',
        },
        user_id: {
          type: 'integer',
          minimum: 1,
          description: 'QQ 号',
          'x-role': 'member_id',
        },
        duration: {
          type: 'integer',
          minimum: 0,
          default: 1800,
          'x-role': 'duration',
        },
      },
    });
  });
});

describe('set_group_whole_ban parse', () => {
  it('defaults enable to true', () => {
    expect(setGroupWholeBan.parse({ group_id: 941657197 })).toEqual({
      ok: true,
      value: { group_id: 941657197, enable: true },
    });
  });

  it('coerces enable false synonyms', () => {
    expect(setGroupWholeBan.parse({ group_id: 941657197, enable: 0 })).toEqual({
      ok: true,
      value: { group_id: 941657197, enable: false },
    });
    expect(setGroupWholeBan.parse({ group_id: 941657197, enable: 'OFF' })).toEqual({
      ok: true,
      value: { group_id: 941657197, enable: false },
    });
  });
});

describe('set_group_whole_ban toHandler', () => {
  it('enables whole-group mute by default', async () => {
    const muteAll = vi.fn(async () => {});
    const { ctx } = adminCtx({ muteAll });

    await expect(setGroupWholeBan.toHandler(ctx)({ group_id: 941657197 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(muteAll.mock.calls).toEqual([[941657197, true]]);
  });

  it('forwards an explicit disable', async () => {
    const muteAll = vi.fn(async () => {});
    const { ctx } = adminCtx({ muteAll });

    await expect(setGroupWholeBan.toHandler(ctx)({
      group_id: 12345,
      enable: false,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(muteAll.mock.calls).toEqual([[12345, false]]);
  });
});

describe('set_group_add_option parse', () => {
  it('defaults add_type to 0 and keeps a present 0', () => {
    expect(setGroupAddOption.parse({ group_id: 12345 })).toEqual({
      ok: true,
      value: { group_id: 12345, add_type: 0, group_question: undefined, group_answer: undefined },
    });
    expect(setGroupAddOption.parse({ group_id: 12345, add_type: 0 })).toEqual({
      ok: true,
      value: { group_id: 12345, add_type: 0, group_question: undefined, group_answer: undefined },
    });
  });

  it('accepts a positive add_type and rejects a negative one', () => {
    expect(setGroupAddOption.parse({ group_id: 12345, add_type: '2' })).toEqual({
      ok: true,
      value: { group_id: 12345, add_type: 2, group_question: undefined, group_answer: undefined },
    });
    expect(setGroupAddOption.parse({ group_id: 12345, add_type: -1 })).toEqual({
      ok: false,
      field: 'add_type',
      reason: 'must be >= 0',
    });
  });

  it('keeps optional question and answer when present', () => {
    expect(setGroupAddOption.parse({
      group_id: 12345,
      add_type: 4,
      group_question: 'q',
      group_answer: 'a',
    })).toEqual({
      ok: true,
      value: {
        group_id: 12345,
        add_type: 4,
        group_question: 'q',
        group_answer: 'a',
      },
    });
  });
});

describe('set_group_add_option toHandler', () => {
  it('forwards the default add_type of 0', async () => {
    const setAddOption = vi.fn(async () => {});
    const { ctx } = adminCtx({ setAddOption });

    await expect(setGroupAddOption.toHandler(ctx)({ group_id: 12345 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setAddOption.mock.calls).toEqual([[12345, 0, undefined, undefined]]);
  });

  it('forwards an explicit add_type', async () => {
    const setAddOption = vi.fn(async () => {});
    const { ctx } = adminCtx({ setAddOption });

    await expect(setGroupAddOption.toHandler(ctx)({
      group_id: 941657197,
      add_type: 3,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setAddOption.mock.calls).toEqual([[941657197, 3, undefined, undefined]]);
  });

  it('forwards question and answer', async () => {
    const setAddOption = vi.fn(async () => {});
    const { ctx } = adminCtx({ setAddOption });

    await expect(setGroupAddOption.toHandler(ctx)({
      group_id: 941657197,
      add_type: 4,
      group_question: 'q',
      group_answer: 'a',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setAddOption.mock.calls).toEqual([[941657197, 4, 'q', 'a']]);
  });
});

describe('set_group_search parse', () => {
  it('leaves both search switches undefined when omitted', () => {
    expect(setGroupSearch.parse({ group_id: 70001 })).toEqual({
      ok: true,
      value: {
        group_id: 70001,
        no_finger_open: undefined,
        no_code_finger_open: undefined,
      },
    });
  });

  it('keeps a present 0 instead of treating it as missing', () => {
    expect(setGroupSearch.parse({
      group_id: 70001,
      no_finger_open: 0,
      no_code_finger_open: '1',
    })).toEqual({
      ok: true,
      value: {
        group_id: 70001,
        no_finger_open: 0,
        no_code_finger_open: 1,
      },
    });
  });

  it('rejects a negative search switch', () => {
    expect(setGroupSearch.parse({ group_id: 70001, no_finger_open: -1 })).toEqual({
      ok: false,
      field: 'no_finger_open',
      reason: 'must be >= 0',
    });
    expect(setGroupSearch.parse({ group_id: 70001, no_code_finger_open: -2 })).toEqual({
      ok: false,
      field: 'no_code_finger_open',
      reason: 'must be >= 0',
    });
  });
});

describe('set_group_search toHandler', () => {
  it('forwards omitted switches as undefined', async () => {
    const setSearch = vi.fn(async () => {});
    const { ctx } = adminCtx({ setSearch });

    await expect(setGroupSearch.toHandler(ctx)({ group_id: 70001 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setSearch.mock.calls).toEqual([[70001, undefined, undefined]]);
  });

  it('forwards both supplied switches', async () => {
    const setSearch = vi.fn(async () => {});
    const { ctx } = adminCtx({ setSearch });

    await expect(setGroupSearch.toHandler(ctx)({
      group_id: 70002,
      no_finger_open: 1,
      no_code_finger_open: 0,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setSearch.mock.calls).toEqual([[70002, 1, 0]]);
  });
});

describe('set_group_member_invite_policy parse', () => {
  it.each([
    'disabled',
    'require_approval',
    'no_approval',
    'no_approval_under_100',
  ] as const)('accepts policy %s', (policy) => {
    expect(setGroupMemberInvitePolicy.parse({ group_id: 12345, policy })).toEqual({
      ok: true,
      value: { group_id: 12345, policy },
    });
  });

  it('requires policy and rejects an unknown value', () => {
    expect(setGroupMemberInvitePolicy.parse({ group_id: 12345 })).toEqual({
      ok: false,
      field: 'policy',
      reason: 'is required',
    });
    expect(setGroupMemberInvitePolicy.parse({
      group_id: 12345,
      policy: 'anything',
    })).toEqual({
      ok: false,
      field: 'policy',
      reason: 'expected one of: disabled, require_approval, no_approval, no_approval_under_100',
    });
  });
});

describe('set_group_member_invite_policy toHandler', () => {
  it('forwards the validated policy', async () => {
    const setMemberInvitePolicy = vi.fn(async () => {});
    const { ctx } = adminCtx({ setMemberInvitePolicy });

    await expect(setGroupMemberInvitePolicy.toHandler(ctx)({
      group_id: '12345',
      policy: 'no_approval_under_100',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setMemberInvitePolicy.mock.calls).toEqual([[12345, 'no_approval_under_100']]);
  });

  it('returns BAD_REQUEST for an unknown policy without calling the API', async () => {
    const setMemberInvitePolicy = vi.fn(async () => {});
    const { ctx } = adminCtx({ setMemberInvitePolicy });

    await expect(setGroupMemberInvitePolicy.toHandler(ctx)({
      group_id: 12345,
      policy: 'open',
    })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'policy: expected one of: disabled, require_approval, no_approval, no_approval_under_100',
    });
    expect(setMemberInvitePolicy).not.toHaveBeenCalled();
  });
});

describe('set_group_new_member_history_visibility parse', () => {
  it('requires visible and coerces boolean synonyms', () => {
    expect(setGroupNewMemberHistoryVisibility.parse({
      group_id: 12345,
      visible: 'false',
    })).toEqual({
      ok: true,
      value: { group_id: 12345, visible: false },
    });
    expect(setGroupNewMemberHistoryVisibility.parse({ group_id: 12345 })).toEqual({
      ok: false,
      field: 'visible',
      reason: 'is required',
    });
  });
});

describe('set_group_new_member_history_visibility toHandler', () => {
  it('forwards the normalized group id and visibility', async () => {
    const setNewMemberHistoryVisibility = vi.fn(async () => {});
    const { ctx } = adminCtx({ setNewMemberHistoryVisibility });

    await expect(setGroupNewMemberHistoryVisibility.toHandler(ctx)({
      group_id: '12345',
      visible: false,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setNewMemberHistoryVisibility.mock.calls).toEqual([[12345, false]]);
  });

  it('returns BAD_REQUEST when visible is missing', async () => {
    const setNewMemberHistoryVisibility = vi.fn(async () => {});
    const { ctx } = adminCtx({ setNewMemberHistoryVisibility });

    await expect(setGroupNewMemberHistoryVisibility.toHandler(ctx)({ group_id: 12345 }))
      .resolves.toEqual({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: 'visible: is required',
      });
    expect(setNewMemberHistoryVisibility).not.toHaveBeenCalled();
  });
});

describe('set_group_member_permissions parse', () => {
  it('accepts a single capability switch and leaves the others undefined', () => {
    expect(setGroupMemberPermissions.parse({
      group_id: 12345,
      allow_member_upload_album: false,
    })).toEqual({
      ok: true,
      value: {
        group_id: 12345,
        allow_member_upload_album: false,
        allow_member_temporary_session: undefined,
        allow_member_create_group: undefined,
      },
    });
  });

  it('coerces every supplied capability switch', () => {
    expect(setGroupMemberPermissions.parse({
      group_id: '12345',
      allow_member_upload_album: 'true',
      allow_member_temporary_session: false,
      allow_member_create_group: 1,
    })).toEqual({
      ok: true,
      value: {
        group_id: 12345,
        allow_member_upload_album: true,
        allow_member_temporary_session: false,
        allow_member_create_group: true,
      },
    });
  });

  it('rejects an empty update after optional fields resolve to undefined', () => {
    expect(setGroupMemberPermissions.parse({ group_id: 12345 })).toEqual({
      ok: false,
      field: '',
      reason: 'at least one of: allow_member_upload_album, allow_member_temporary_session, allow_member_create_group',
    });
  });
});

describe('set_group_member_permissions toHandler', () => {
  it('remaps all supplied switches into the group-admin payload', async () => {
    const setMemberPermissions = vi.fn(async () => {});
    const { ctx } = adminCtx({ setMemberPermissions });

    await expect(setGroupMemberPermissions.toHandler(ctx)({
      group_id: '12345',
      allow_member_upload_album: 'true',
      allow_member_temporary_session: false,
      allow_member_create_group: 1,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setMemberPermissions.mock.calls).toEqual([[12345, {
      allowMemberUploadAlbum: true,
      allowMemberTemporarySession: false,
      allowMemberCreateGroup: true,
    }]]);
  });

  it('forwards a single supplied switch with the others undefined', async () => {
    const setMemberPermissions = vi.fn(async () => {});
    const { ctx } = adminCtx({ setMemberPermissions });

    await expect(setGroupMemberPermissions.toHandler(ctx)({
      group_id: 12345,
      allow_member_temporary_session: true,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setMemberPermissions.mock.calls).toEqual([[12345, {
      allowMemberUploadAlbum: undefined,
      allowMemberTemporarySession: true,
      allowMemberCreateGroup: undefined,
    }]]);
  });

  it('returns BAD_REQUEST for an empty update without calling the API', async () => {
    const setMemberPermissions = vi.fn(async () => {});
    const { ctx } = adminCtx({ setMemberPermissions });

    await expect(setGroupMemberPermissions.toHandler(ctx)({ group_id: 12345 }))
      .resolves.toEqual({
        status: 'failed',
        retcode: 1400,
        data: null,
        wording: 'at least one of: allow_member_upload_album, allow_member_temporary_session, allow_member_create_group',
      });
    expect(setMemberPermissions).not.toHaveBeenCalled();
  });
});

describe('get_group_admin_settings parse', () => {
  it('requires group_id and has no extra params', () => {
    expect(getGroupAdminSettings.parse({})).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'is required',
    });
    expect(getGroupAdminSettings.parse({ group_id: 12345 })).toEqual({
      ok: true,
      value: { group_id: 12345 },
    });
  });
});

describe('get_group_admin_settings toHandler', () => {
  it('forwards group_id and returns the current settings', async () => {
    const settings = {
      add_type: 2,
      group_question: 'q',
      group_answer: 'a',
      robot_member_switch: 1,
      robot_member_examine: 0,
      member_invite_policy: 'require_approval',
      allow_member_upload_album: true,
      allow_member_temporary_session: false,
      allow_member_create_group: true,
      new_member_history_visible: true,
      no_finger_open: 0,
      no_code_finger_open: 1,
    };
    const getAdminSettings = vi.fn(async () => settings);
    const { ctx } = adminCtx({ getAdminSettings });

    await expect(getGroupAdminSettings.toHandler(ctx)({ group_id: 12345 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: settings });
    expect(getAdminSettings.mock.calls).toEqual([[12345]]);
  });
});

describe('set_group_member_permissions describe', () => {
  it('documents the at-least-one capability invariant', () => {
    const doc = setGroupMemberPermissions.describe();

    expect(doc.name).toBe('set_group_member_permissions');
    expect(doc.summary).toBe('设置群成员权限（仅群主可改）');
    expect(doc.invariants).toEqual([
      'at least one of: allow_member_upload_album, allow_member_temporary_session, allow_member_create_group',
    ]);
    expect(doc.inputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
      required: ['group_id'],
      properties: {
        group_id: {
          type: 'integer',
          minimum: 1,
          description: '群号',
          'x-role': 'group_id',
        },
        allow_member_upload_album: { type: 'boolean' },
        allow_member_temporary_session: { type: 'boolean' },
        allow_member_create_group: { type: 'boolean' },
      },
    });
  });
});

describe('set_group_admin parse', () => {
  it('defaults enable to true', () => {
    expect(setGroupAdmin.parse({ group_id: 314159, user_id: 271828 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, enable: true },
    });
  });

  it('accepts an explicit disable', () => {
    expect(setGroupAdmin.parse({
      group_id: 314159,
      user_id: 271828,
      enable: 'no',
    })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, enable: false },
    });
  });
});

describe('set_group_admin toHandler', () => {
  it('promotes a member with the default enable flag', async () => {
    const setAdmin = vi.fn(async () => {});
    const { ctx } = adminCtx({ setAdmin });

    await expect(setGroupAdmin.toHandler(ctx)({ group_id: 314159, user_id: 271828 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setAdmin.mock.calls).toEqual([[314159, 271828, true]]);
  });

  it('forwards an explicit demotion', async () => {
    const setAdmin = vi.fn(async () => {});
    const { ctx } = adminCtx({ setAdmin });

    await expect(setGroupAdmin.toHandler(ctx)({
      group_id: 80004,
      user_id: 30005,
      enable: false,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setAdmin.mock.calls).toEqual([[80004, 30005, false]]);
  });
});

describe('set_group_card parse', () => {
  it('defaults card to an empty string and keeps an explicit empty clear', () => {
    expect(setGroupCard.parse({ group_id: 314159, user_id: 271828 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, card: '' },
    });
    expect(setGroupCard.parse({
      group_id: 314159,
      user_id: 271828,
      card: '',
    })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, card: '' },
    });
  });

  it('stringifies a numeric card and rejects a non-stringifiable value', () => {
    expect(setGroupCard.parse({
      group_id: 314159,
      user_id: 271828,
      card: 404,
    })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, card: '404' },
    });
    expect(setGroupCard.parse({
      group_id: 314159,
      user_id: 271828,
      card: { text: 'nick' },
    })).toEqual({
      ok: false,
      field: 'card',
      reason: 'expected a string',
    });
  });
});

describe('set_group_card toHandler', () => {
  it('forwards the default empty card as a clear', async () => {
    const setCard = vi.fn(async () => {});
    const { ctx } = adminCtx({ setCard });

    await expect(setGroupCard.toHandler(ctx)({ group_id: 314159, user_id: 271828 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setCard.mock.calls).toEqual([[314159, 271828, '']]);
  });

  it('forwards an explicit card string', async () => {
    const setCard = vi.fn(async () => {});
    const { ctx } = adminCtx({ setCard });

    await expect(setGroupCard.toHandler(ctx)({
      group_id: 80005,
      user_id: 30006,
      card: '值班号',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setCard.mock.calls).toEqual([[80005, 30006, '值班号']]);
  });
});

describe('set_group_name parse', () => {
  it('defaults group_name to an empty string', () => {
    expect(setGroupName.parse({ group_id: 314159 })).toEqual({
      ok: true,
      value: { group_id: 314159, group_name: '' },
    });
  });

  it('stringifies a boolean group_name', () => {
    expect(setGroupName.parse({ group_id: 314159, group_name: true })).toEqual({
      ok: true,
      value: { group_id: 314159, group_name: 'true' },
    });
  });
});

describe('set_group_name toHandler', () => {
  it('forwards the default empty name', async () => {
    const setName = vi.fn(async () => {});
    const { ctx } = adminCtx({ setName });

    await expect(setGroupName.toHandler(ctx)({ group_id: 314159 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setName.mock.calls).toEqual([[314159, '']]);
  });

  it('forwards an explicit group name', async () => {
    const setName = vi.fn(async () => {});
    const { ctx } = adminCtx({ setName });

    await expect(setGroupName.toHandler(ctx)({
      group_id: 941657197,
      group_name: 'Muted Group',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setName.mock.calls).toEqual([[941657197, 'Muted Group']]);
  });
});

describe('set_group_leave parse', () => {
  it('requires only group_id and drops undeclared keys', () => {
    expect(setGroupLeave.parse({ group_id: 314159, extra: true })).toEqual({
      ok: true,
      value: { group_id: 314159 },
    });
  });

  it('rejects a missing group_id', () => {
    expect(setGroupLeave.parse({})).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'is required',
    });
  });
});

describe('set_group_leave toHandler', () => {
  it('forwards the group id to leave', async () => {
    const leave = vi.fn(async () => {});
    const { ctx } = adminCtx({ leave });

    await expect(setGroupLeave.toHandler(ctx)({ group_id: 314159 }))
      .resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(leave.mock.calls).toEqual([[314159]]);
  });

  it('returns BAD_REQUEST for group_id 0 without leaving', async () => {
    const leave = vi.fn(async () => {});
    const { ctx } = adminCtx({ leave });

    await expect(setGroupLeave.toHandler(ctx)({ group_id: 0 })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'group_id: must be >= 1',
    });
    expect(leave).not.toHaveBeenCalled();
  });
});

describe('set_group_special_title parse', () => {
  it('defaults special_title to an empty string', () => {
    expect(setGroupSpecialTitle.parse({ group_id: 314159, user_id: 271828 })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, special_title: '' },
    });
  });

  it('keeps an explicit empty title', () => {
    expect(setGroupSpecialTitle.parse({
      group_id: 314159,
      user_id: 271828,
      special_title: '',
    })).toEqual({
      ok: true,
      value: { group_id: 314159, user_id: 271828, special_title: '' },
    });
  });
});

describe('set_group_special_title toHandler', () => {
  it('forwards the default empty title', async () => {
    const setSpecialTitle = vi.fn(async () => {});
    const { ctx } = adminCtx({ setSpecialTitle });

    await expect(setGroupSpecialTitle.toHandler(ctx)({
      group_id: 314159,
      user_id: 271828,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setSpecialTitle.mock.calls).toEqual([[314159, 271828, '']]);
  });

  it('forwards an explicit title', async () => {
    const setSpecialTitle = vi.fn(async () => {});
    const { ctx } = adminCtx({ setSpecialTitle });

    await expect(setGroupSpecialTitle.toHandler(ctx)({
      group_id: 80006,
      user_id: 30007,
      special_title: '龙王',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setSpecialTitle.mock.calls).toEqual([[80006, 30007, '龙王']]);
  });
});

describe('set_group_anonymous parse', () => {
  it('accepts any params and returns an empty object', () => {
    expect(setGroupAnonymous.parse({})).toEqual({ ok: true, value: {} });
    expect(setGroupAnonymous.parse({ group_id: 314159, enable: true })).toEqual({
      ok: true,
      value: {},
    });
  });
});

describe('set_group_anonymous toHandler', () => {
  it('returns ok without touching the bridge', async () => {
    await expect(setGroupAnonymous.toHandler({} as ApiActionContext)({
      group_id: 314159,
      enable: false,
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });
  });
});

describe('set_group_anonymous describe', () => {
  it('documents the unimplemented anonymous switch', () => {
    const doc = setGroupAnonymous.describe();

    expect(doc.name).toBe('set_group_anonymous');
    expect(doc.summary).toBe('匿名开关（未实现，返回 ok）');
    expect(doc.readOnly).toBe(false);
    expect(doc.params).toEqual([]);
    expect(doc.invariants).toEqual([]);
    expect(doc.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
  });
});

describe('set_group_anonymous_ban parse', () => {
  it('accepts any params and returns an empty object', () => {
    expect(setGroupAnonymousBan.parse({
      group_id: 314159,
      anonymous_flag: 'x',
      duration: 60,
    })).toEqual({ ok: true, value: {} });
  });
});

describe('set_group_anonymous_ban toHandler', () => {
  it('returns ok without touching the bridge', async () => {
    await expect(setGroupAnonymousBan.toHandler({} as ApiActionContext)({
      flag: 'anon',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });
  });
});

describe('set_group_anonymous_ban describe', () => {
  it('documents the unimplemented anonymous mute', () => {
    expect(setGroupAnonymousBan.describe().summary).toBe('匿名禁言（未实现，返回 ok）');
  });
});

describe('set_group_portrait parse', () => {
  it('requires a non-empty image source and stringifies primitives', () => {
    expect(setGroupPortrait.parse({
      group_id: 314159,
      file: 'https://example.invalid/avatar.png',
    })).toEqual({
      ok: true,
      value: { group_id: 314159, file: 'https://example.invalid/avatar.png' },
    });
    expect(setGroupPortrait.parse({ group_id: 314159, file: 10001 })).toEqual({
      ok: true,
      value: { group_id: 314159, file: '10001' },
    });
  });

  it('rejects a missing or empty file', () => {
    expect(setGroupPortrait.parse({ group_id: 314159 })).toEqual({
      ok: false,
      field: 'file',
      reason: 'is required',
    });
    expect(setGroupPortrait.parse({ group_id: 314159, file: '' })).toEqual({
      ok: false,
      field: 'file',
      reason: 'must not be empty',
    });
  });

  it('rejects a non-stringifiable file', () => {
    expect(setGroupPortrait.parse({
      group_id: 314159,
      file: { url: 'https://example.invalid/avatar.png' },
    })).toEqual({
      ok: false,
      field: 'file',
      reason: 'expected a string',
    });
  });
});

describe('set_group_portrait toHandler', () => {
  it('forwards the image source to profile.setGroupAvatar', async () => {
    const { ctx, setGroupAvatar } = portraitCtx();

    await expect(setGroupPortrait.toHandler(ctx)({
      group_id: 314159,
      file: 'base64://abc',
    })).resolves.toEqual({ status: 'ok', retcode: 0, data: null });

    expect(setGroupAvatar.mock.calls).toEqual([[314159, 'base64://abc']]);
  });

  it('returns BAD_REQUEST for an empty file without setting the avatar', async () => {
    const { ctx, setGroupAvatar } = portraitCtx();

    await expect(setGroupPortrait.toHandler(ctx)({
      group_id: 314159,
      file: '',
    })).resolves.toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'file: must not be empty',
    });
    expect(setGroupAvatar).not.toHaveBeenCalled();
  });
});
