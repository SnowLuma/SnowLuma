import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { ProtocolHostClient, type ProtocolHostProcess } from '../src/protocol-host-client';

class FakeHostProcess extends EventEmitter implements ProtocolHostProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: vi.fn(() => true) };
  readonly kill = vi.fn(() => true);
}

describe('ProtocolHostClient', () => {
  it('reassembles split NDJSON frames and surfaces QR code events', () => {
    const process = new FakeHostProcess();
    const client = new ProtocolHostClient(process);
    const listener = vi.fn();
    client.on('qrcode', listener);

    process.stdout.emit('data', Buffer.from('{"event":"qrcode","url":"https://txz.qq.com/p?k=1",'));
    process.stdout.emit('data', Buffer.from('"imageBase64":"aW1n"}\r\n'));

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      url: 'https://txz.qq.com/p?k=1',
      image: Buffer.from('img'),
    });
  });

  it('correlates a raw SSO reply with sendPacket', async () => {
    const process = new FakeHostProcess();
    const client = new ProtocolHostClient(process);
    const pending = client.sendPacket('OidbSvcTrpcTcp.0x88d_0', Buffer.from([1, 2]), 5000);

    const command = JSON.parse(process.stdin.write.mock.calls[0]![0] as string) as { id: number };
    process.stdout.emit('data', Buffer.from(`${JSON.stringify({
      id: command.id,
      ok: true,
      retCode: 0,
      bodyBase64: Buffer.from([3, 4]).toString('base64'),
    })}\n`));

    await expect(pending).resolves.toEqual({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from([3, 4]),
    });
  });

  it('fails pending sends when the host exits', async () => {
    const process = new FakeHostProcess();
    const client = new ProtocolHostClient(process);
    const pending = client.sendPacket('test.cmd', Buffer.alloc(0));

    process.emit('exit', 7, null);

    await expect(pending).resolves.toMatchObject({
      success: false,
      gotResponse: false,
      errorCode: -1,
    });
  });
});
