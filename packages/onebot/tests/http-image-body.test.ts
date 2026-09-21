import { afterEach, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { JsonObject } from '../src/types';

let adapter: HttpServerAdapter | undefined;

afterEach(async () => {
  await adapter?.close();
  adapter = undefined;
});

it('accepts base64 images above 2 MiB, returns 413 for oversize and stays usable', async () => {
  const handle = vi.fn(async () => ({ status: 'ok', retcode: 0, data: {} }));
  adapter = new HttpServerAdapter(
    'image-body',
    {
      name: 'image-body',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    },
    {
      uin: '10001',
      api: { isStreamAction: () => false, handle } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    },
  );
  await adapter.open();
  const port = ((adapter as unknown as { server: http.Server }).server.address() as AddressInfo).port;

  async function post(body: string): Promise<{ status: number; body: JsonObject }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/send_group_msg',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as JsonObject,
          });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  const image = JSON.stringify({
    group_id: 1,
    message: [{
      type: 'image',
      data: { file: 'base64://' + Buffer.alloc(1_644_101).toString('base64') },
    }],
  });
  expect((await post(image)).status).toBe(200);
  expect(handle).toHaveBeenCalledTimes(1);
  expect(await post(JSON.stringify({ padding: 'x'.repeat(64 * 1024 * 1024) }))).toMatchObject({
    status: 413,
    body: { status: 'failed', retcode: 1413 },
  });
  expect(handle).toHaveBeenCalledTimes(1);
  expect((await post('{}')).status).toBe(200);
  expect(handle).toHaveBeenCalledTimes(2);
}, 20_000);
