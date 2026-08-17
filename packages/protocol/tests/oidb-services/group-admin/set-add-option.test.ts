import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0AddOption } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import {
  isQuestionAddType,
  SetAddOption,
  wireAddType,
} from '../../../src/oidb-services/group-admin/set-add-option';
import { env, v, s, m } from '../_pb-oracle';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetAddOption namespace', () => {
  it('declares 0x89A_0 (shared cmd with MuteAll / SetSearch / SetGroupName)', () => {
    expect(SetAddOption.command).toBe(0x89A);
    expect(SetAddOption.subCommand).toBe(0);
  });

  it('packages settings.addType and routes to 0x89a_0', async () => {
    const deps = makeDeps();
    await SetAddOption.invoke(deps, { groupId: 12345, addType: 2 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x89a_0');
    const decoded = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(bytes);
    expect(decoded.body).toMatchObject({ groupUin: 12345n, settings: { addType: 2 } });
    expect(decoded.body?.settings?.groupQuestion ?? undefined).toBeUndefined();
    expect(decoded.body?.settings?.groupAnswer ?? undefined).toBeUndefined();
  });

  it('treats 4 as question+answer and 5/55 as question-only', () => {
    expect(isQuestionAddType(4)).toBe(true);
    expect(isQuestionAddType(5)).toBe(true);
    expect(isQuestionAddType(55)).toBe(true);
    expect(isQuestionAddType(2)).toBe(false);
    expect(wireAddType(55)).toBe(5);
    expect(wireAddType(4)).toBe(4);
  });

  it('byte-oracle: type 4 writes question and answer', async () => {
    const deps = makeDeps();
    await SetAddOption.invoke(deps, {
      groupId: 12345, addType: 4, groupQuestion: 'q', groupAnswer: 'a',
    });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const settings = [...v(16, 4), ...s(30, 'q'), ...s(31, 'a')];
    const body = [...v(1, 12345), ...m(2, settings)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0x89A, 0, body, false));
  });

  it('byte-oracle: type 5 writes question and clears answer', async () => {
    const deps = makeDeps();
    await SetAddOption.invoke(deps, {
      groupId: 12345, addType: 5, groupQuestion: 'why', groupAnswer: 'ignored',
    });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const settings = [...v(16, 5), ...s(30, 'why'), ...s(31, '')];
    const body = [...v(1, 12345), ...m(2, settings)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0x89A, 0, body, false));
  });

  it('maps add_type 55 onto the official question-only mode', async () => {
    const deps = makeDeps();
    await SetAddOption.invoke(deps, { groupId: 1, addType: 55, groupQuestion: 'q' });
    const decoded = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(
      deps.sendRawPacket.mock.calls[0]![1],
    );
    expect(decoded.body?.settings).toMatchObject({
      addType: 5, groupQuestion: 'q', groupAnswer: '',
    });
  });
});
