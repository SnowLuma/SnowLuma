import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupFileReq, OidbGroupFileResp } from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { RenameGroupFile } from '../../../src/oidb-services/group-file/rename-group-file';

// A success response the real server would send: command/sub echoed, rename
// ret slot with retCode 0. Lets `invoke`'s deserialize pass so we can assert
// the request wire (cmd name + body) without it throwing on an empty body.
function okRenameResponse(): Buffer {
  const env: OidbBase<OidbGroupFileResp> = {
    command: 0x6D6, subCommand: 4, body: { rename: { retCode: 0 } },
  };
  return Buffer.from(protobuf_encode<OidbBase<OidbGroupFileResp>>(env));
}

function makeSender() {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: okRenameResponse(),
  };
  return { sendRawPacket: vi.fn(async () => defaultResp) };
}

describe('RenameGroupFile namespace', () => {
  it('declares command 0x6D6 sub 4 (rename slot), uin form', () => {
    expect(RenameGroupFile.command).toBe(0x6D6);
    expect(RenameGroupFile.subCommand).toBe(4);
    expect(RenameGroupFile.uinForm).toBe(true);
  });

  it('serializes into the rename slot with busId 102 and the current parent folder', () => {
    const out = RenameGroupFile.serialize({} as any, {
      groupId: 12345, fileId: '/abc', parentDirectory: '/sub', newFileName: 'new.txt',
    });
    expect(out).toEqual({
      rename: {
        groupUin: 12345, busId: 102, fileId: '/abc', parentFolder: '/sub', newFileName: 'new.txt',
      },
    });
  });

  it('round-trips the rename body through the OIDB envelope (locks the pb field tags)', async () => {
    const sender = makeSender();
    await RenameGroupFile.invoke(sender, {
      groupId: 12345, fileId: '/abc', parentDirectory: '/', newFileName: 'new.txt',
    });
    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x6d6_4');
    const env = protobuf_decode<OidbBase<OidbGroupFileReq>>(bytes);
    expect(env.command).toBe(0x6D6);
    expect(env.subCommand).toBe(4);
    expect(env.body.rename).toMatchObject({
      groupUin: 12345, busId: 102, fileId: '/abc', parentFolder: '/', newFileName: 'new.txt',
    });
  });

  it('deserialize throws when the rename slot is missing from the response', () => {
    expect(() => RenameGroupFile.deserialize({} as any, {})).toThrow(/rename response missing/);
  });
});
