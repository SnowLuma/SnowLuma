import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xdc2_34Resp } from '@snowluma/proto-defs/oidb-actions/contact-ark';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { SendTuwenArk } from '../../../src/oidb-services/contacts/send-tuwen-ark';
import { env, v, s, m } from '../_pb-oracle';

function makeSender() {
  const respEnv: OidbBase<Oidb0xdc2_34Resp> = { command: 0xDC2, subCommand: 34, body: {} };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0xdc2_34Resp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SendTuwenArk namespace', () => {
  it('declares command 0xdc2 sub 34, SSO: OidbSvcTrpcTcp.0xdc2_34', () => {
    expect(SendTuwenArk.command).toBe(0xDC2);
    expect(SendTuwenArk.subCommand).toBe(34);
    expect(SendTuwenArk.uinForm).toBe(false);
  });

  it('serializes fixed appId=100446242, field2=1, field3=0, field5={1:1}', () => {
    const out = SendTuwenArk.serialize({} as any, {
      targetId: 12345,
      peerType: 1,
      title: 'T',
      desc: 'D',
      summary: 'S',
      jumpUrl: 'https://example.com',
      previewUrl: '',
    });
    expect(out.appInfo).toMatchObject({
      appId: 100446242,
      field2: 1,
      field3: 0,
      field5: { field1: 1 },
      targetId: 12345,
    });
  });

  it('byte-oracle: C2C (peerType=0) — peerType omitted on wire, field3=0 present, previewUrl present', async () => {
    const sender = makeSender();
    await SendTuwenArk.invoke(sender, {
      targetId: 2863253201,
      peerType: 0,
      title: 'QQ开放平台',
      desc: 'QQ小程序是连接广轻用户的新方式，覆盖8亿新生代活跃网民。轻便快捷的开发模式，将能在QQ内被轻松获取和传播',
      summary: '[分享] QQ开放平台',
      jumpUrl: 'https://q.qq.com/r',
      previewUrl: 'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png',
    });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xdc2_34');

    // AppInfo embedding: field5={1:1}, content={1:1, 10:title, 11:desc, 12:summary, 13:jumpUrl, 14:previewUrl}, then appId/field2/field3/targetId
    const field5 = m(5, [...v(1, 1)]);
    const content = m(12, [
      ...v(1, 1),
      ...s(10, 'QQ开放平台'),
      ...s(11, 'QQ小程序是连接广轻用户的新方式，覆盖8亿新生代活跃网民。轻便快捷的开发模式，将能在QQ内被轻松获取和传播'),
      ...s(12, '[分享] QQ开放平台'),
      ...s(13, 'https://q.qq.com/r'),
      ...s(14, 'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png'),
    ]);
    const appInfo = m(1, [
      ...v(1, 100446242),
      ...v(2, 1),
      ...v(3, 0), // field3=0 is present in wire (pb_optional preserves zero as expected)
      ...field5,
      ...v(11, 2863253201),
      ...content,
    ]);
    // Meta: peerType=0 is present in wire (pb_optional preserves zero as expected)
    const meta = m(2, [
      ...v(1, 0),
      ...v(2, 2863253201),
    ]);
    const body = [...appInfo, ...meta];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xDC2, 34, body, false));
  });

  it('byte-oracle: group (peerType=1) — peerType present, field3=0 present, empty previewUrl present', async () => {
    const sender = makeSender();
    await SendTuwenArk.invoke(sender, {
      targetId: 123456789,
      peerType: 1,
      title: '测试标题',
      desc: '测试描述',
      summary: '测试摘要',
      jumpUrl: 'https://example.com/jump',
      previewUrl: '',
    });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xdc2_34');

    const field5 = m(5, [...v(1, 1)]);
    const content = m(12, [
      ...v(1, 1),
      ...s(10, '测试标题'),
      ...s(11, '测试描述'),
      ...s(12, '测试摘要'),
      ...s(13, 'https://example.com/jump'),
      ...s(14, ''), // previewUrl='' is present in wire (pb_optional preserves empty string as expected)
    ]);
    const appInfo = m(1, [
      ...v(1, 100446242),
      ...v(2, 1),
      ...v(3, 0), // field3=0 is present
      ...field5,
      ...v(11, 123456789),
      ...content,
    ]);
    // Meta: peerType=1 present
    const meta = m(2, [
      ...v(1, 1),
      ...v(2, 123456789),
    ]);
    const body = [...appInfo, ...meta];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xDC2, 34, body, false));
  });

  it('deserialize returns undefined (void response)', () => {
    expect(SendTuwenArk.deserialize({} as any, {})).toBeUndefined();
  });
});
