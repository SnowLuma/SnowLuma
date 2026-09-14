import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeHttpClient, parseMaxStreamBytes, parseTimeoutMs } from '../src/client';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Verifies the HTTP bridge: a OneBot action becomes a POST of `{ action, params }`
// to the endpoint (with Bearer auth), and the JSON envelope comes back verbatim.
// A fake fetch stands in for the network.
describe('makeHttpClient — OneBot HTTP wiring', () => {
  it('validates SNOWLUMA_MCP_MAX_STREAM_BYTES as a positive 4 GiB-or-lower integer', () => {
    expect(parseMaxStreamBytes(undefined)).toBeUndefined();
    expect(parseMaxStreamBytes('1048576')).toBe(1048576);
    for (const invalid of ['', '0', '-1', '1.5', '1e6', String(4 * 1024 * 1024 * 1024 + 1), 'nope']) {
      expect(() => parseMaxStreamBytes(invalid), invalid).toThrow(/SNOWLUMA_MCP_MAX_STREAM_BYTES/);
    }
  });

  it('fails fast on an invalid SNOWLUMA_MCP_TIMEOUT_MS', () => {
    expect(parseTimeoutMs(undefined)).toBeUndefined();
    expect(parseTimeoutMs('30000')).toBe(30000);
    for (const invalid of ['', '0', '-1', '1.5', '1e3', 'nope']) {
      expect(() => parseTimeoutMs(invalid), invalid).toThrow(/SNOWLUMA_MCP_TIMEOUT_MS/);
    }
  });

  it('rejects an invalid programmatic timeout instead of silently using the default', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', timeoutMs }), String(timeoutMs))
        .toThrow(/timeoutMs.*positive.*integer/i);
    }
  });

  it('creates the configured stream directory at client startup and rejects a file path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-config-'));
    tempDirs.push(root);
    const nested = path.join(root, 'nested', 'downloads');
    expect(() => makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', streamDir: nested })).not.toThrow();
    expect(fs.statSync(nested).isDirectory()).toBe(true);

    const filePath = path.join(root, 'not-a-directory');
    fs.writeFileSync(filePath, 'x');
    expect(() => makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', streamDir: filePath })).toThrow(/streamDir.*(?:not a directory|cannot be created)/i);
  });

  it('fails startup when the stream directory cannot be accessed or create files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-config-'));
    tempDirs.push(root);

    vi.spyOn(fs, 'accessSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', streamDir: root }))
      .toThrow(/streamDir.*readable.*writable.*traversable.*permission denied/i);

    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('create denied'), { code: 'EACCES' });
    });
    expect(() => makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', streamDir: root }))
      .toThrow(/streamDir.*cannot create files.*create denied/i);
  });

  it('POSTs {action, params} to the endpoint and returns the parsed envelope', async () => {
    const calls: Array<{ url: string; body: any; auth?: string }> = [];
    const fakeFetch = (async (url: unknown, init: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body as string),
        auth: (init.headers as Record<string, string>)?.Authorization,
      });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', accessToken: 'tok', fetch: fakeFetch });
    const env = await client.call('get_status', { x: 1 });

    expect(env.status).toBe('ok');
    expect(env.retcode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:9999/');
    expect(calls[0].body.action).toBe('get_status');
    expect(calls[0].body.params).toEqual({ x: 1 });
    expect(calls[0].auth).toBe('Bearer tok');
  });

  it('propagates a transport failure as a rejection (so the tool layer can map it)', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });
    await expect(client.call('get_status', {})).rejects.toThrow();
  });

  it('incrementally parses stream frames across arbitrary network chunk boundaries', async () => {
    const frames = [
      { status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'stream', data_type: 'data_chunk', data: 'Index-> 1' } },
      { status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'response', data_type: 'data_complete', data: 'done' } },
    ];
    const wire = frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join('');
    const cuts = [1, 7, 19, 31, 57, wire.length];
    const chunks: Uint8Array[] = [];
    let offset = 0;
    for (const cut of cuts) {
      chunks.push(new TextEncoder().encode(wire.slice(offset, cut)));
      offset = cut;
    }
    const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });
    const result = await client.callStream('test_download_stream', {});

    expect(result).toEqual({ frame_count: 2, frames: [frames[0]], terminal: frames[1] });
  });

  it('writes a multi-frame file download atomically and returns metadata instead of base64', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const content = Buffer.from('streamed file content '.repeat(200));
    const parts = [content.subarray(0, 997), content.subarray(997)];
    const frames = [
      { status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'stream', data_type: 'file_info', file_name: '../unsafe.bin', file_size: content.length, chunk_size: 997 } },
      ...parts.map((part, index) => ({ status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'stream', data_type: 'file_chunk', index, size: part.length, data: part.toString('base64') } })),
      { status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'response', data_type: 'file_complete', total_chunks: parts.length, total_bytes: content.length } },
    ];
    const wire = frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join('');
    const fakeFetch = (async () => new Response(wire, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    const result = await client.callStream('download_file_stream', { file: 'remote-id' });

    expect(Object.keys(result).sort()).toEqual(['file_path', 'file_size', 'frame_count', 'sha256', 'terminal']);
    expect(result.file_size).toBe(content.length);
    expect(result.frame_count).toBe(frames.length);
    expect(result.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(path.isAbsolute(result.file_path)).toBe(true);
    expect(path.dirname(result.file_path)).toBe(fs.realpathSync(streamDir));
    expect(fs.readFileSync(result.file_path).equals(content)).toBe(true);
    expect(fs.readdirSync(streamDir).some((name) => name.endsWith('.part'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(parts[0].toString('base64'));
  });

  it('surfaces a terminal stream error with action/frame context and removes the partial file', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'broken.bin', file_size: 3 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: 3, data: Buffer.from('abc').toString('base64') } },
      { status: 'failed', retcode: 100, wording: 'source disconnected', data: { type: 'error', data_type: 'error' } },
    ];
    const wire = frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join('');
    const fakeFetch = (async () => new Response(wire, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download_file_stream.*frame 2.*source disconnected/i);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('removes the partial file when the response body disconnects before a terminal frame', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const prefix = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'cut.bin', file_size: 6 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: 3, data: Buffer.from('abc').toString('base64') } },
    ].map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join('');
    const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.error(new Error('socket reset'));
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download_file_stream.*body.*socket reset/i);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('enforces the configured byte ceiling while streaming and removes the partial file', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'too-big.bin', file_size: 3 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: 4, data: Buffer.from('abcd').toString('base64') } },
    ];
    const fakeFetch = (async () => new Response(frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join(''), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir, maxStreamBytes: 3 });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/frame 1.*exceed.*3 bytes/i);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('fails fast when a non-file stream exceeds the bounded frame summary count', async () => {
    const frames = Array.from({ length: 257 }, (_, index) => ({
      status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: `frame-${index}` },
    }));
    const fakeFetch = (async () => new Response(frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join(''), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/test_download_stream.*frame 256.*summary.*256/i);
  });

  it('fails fast when a non-file stream exceeds the bounded summary text size', async () => {
    const frame = { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'x'.repeat(256 * 1024) } };
    const fakeFetch = (async () => new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/test_download_stream.*frame 0.*summary text.*262144/i);
  });

  it('rejects malformed base64 file frames and removes the partial file', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'bad.bin', file_size: 0 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: 0, data: '%%%=' } },
    ];
    const fakeFetch = (async () => new Response(frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join(''), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download_file_stream.*frame 1.*base64/i);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('accepts upload_file_stream single-frame acknowledgements without requiring a response-type terminal', async () => {
    const ack = { status: 'ok', retcode: 0, stream: 'stream-action', data: { type: 'stream', status: 'chunk_received', received_chunks: 1, total_chunks: 2 } };
    const fakeFetch = (async () => new Response(`${JSON.stringify(ack)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('upload_file_stream', { stream_id: 'id', chunk_index: 0, chunk_data: 'YQ==' }))
      .resolves.toEqual({ frame_count: 1, frames: [], terminal: ack });
  });

  it('refuses MCP-host file upload unless an upload root is explicitly configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-upload-'));
    tempDirs.push(dir);
    const inputFile = path.join(dir, 'local.txt');
    fs.writeFileSync(inputFile, 'local');
    let fetchCalls = 0;
    const fakeFetch = (async () => { fetchCalls++; throw new Error('fetch must not run'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('upload_file_stream', {}, { inputFile })).rejects.toThrow(/upload_file_stream.*resolve input.*SNOWLUMA_MCP_UPLOAD_ROOT/i);
    expect(fetchCalls).toBe(0);
  });

  it('rejects an unterminated wire frame before its buffer can grow beyond the 24 MiB frame cap', async () => {
    const oversized = new Uint8Array(24 * 1024 * 1024 + 1).fill(0x78);
    const fakeFetch = (async () => new Response(oversized, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/test_download_stream.*frame 0.*wire.*25165824/i);
  });

  it('actively cancels the response body when frame parsing fails', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not-json\r\n\r\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/frame 0.*invalid JSON/i);
    expect(cancelled).toBe(true);
  });

  it('rejects EOF on a generic stream that never produced a response terminal', async () => {
    const frame = { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'only-intermediate' } };
    const fakeFetch = (async () => new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/test_download_stream.*EOF.*missing.*response terminal/i);
  });

  it('rejects any generic frame after the unique response terminal', async () => {
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'response', data_type: 'data_complete', data: 'done' } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'late' } },
    ];
    const fakeFetch = (async () => new Response(frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join(''), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/test_download_stream.*frame 1.*after response terminal.*frame 0/i);
  });

  it('realpaths upload inputs and rejects a symlink that escapes the configured upload root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-outside-'));
    tempDirs.push(root, outside);
    const outsideFile = path.join(outside, 'secret.txt');
    const link = path.join(root, 'escape.txt');
    fs.writeFileSync(outsideFile, 'secret');
    fs.symlinkSync(outsideFile, link);
    let fetchCalls = 0;
    const fakeFetch = (async () => { fetchCalls++; throw new Error('fetch must not run'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    await expect(client.callStream('upload_file_stream', {}, { inputFile: link })).rejects.toThrow(/upload_file_stream.*resolve input.*outside.*upload root/i);
    expect(fetchCalls).toBe(0);
  });

  it('uploads an allowed MCP-host file in fixed chunks and returns a base64-free summary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'payload.bin');
    const content = Buffer.alloc(600 * 1024);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    fs.writeFileSync(inputFile, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const requests: Array<Record<string, any>> = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, any>;
      requests.push(request);
      const p = request.params;
      const data = p.is_complete
        ? { type: 'response', status: 'file_complete', file_path: '/snowluma/upload/payload.bin', file_size: content.length, sha256, total_chunks: 2 }
        : { type: 'stream', status: 'chunk_received', received_chunks: p.chunk_index + 1, total_chunks: 2 };
      const frame = { status: 'ok', retcode: 0, stream: 'stream-action', data };
      return new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    const result = await client.callStream('upload_file_stream', { file_retention: 0 }, { inputFile });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.action === 'upload_file_stream')).toBe(true);
    const chunks = requests.slice(0, 2).map((request) => Buffer.from(request.params.chunk_data, 'base64'));
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
    expect(requests[0].params).toMatchObject({ chunk_index: 0, total_chunks: 2, file_size: content.length, filename: 'payload.bin', file_retention: 0 });
    expect(requests[1].params).toMatchObject({ chunk_index: 1, total_chunks: 2 });
    expect(requests[2].params).toMatchObject({ is_complete: true, expected_sha256: sha256, file_size: content.length });
    expect(new Set(requests.map((request) => request.params.stream_id)).size).toBe(1);
    expect(result).toMatchObject({
      file_path: '/snowluma/upload/payload.bin',
      file_size: content.length,
      sha256,
      chunk_count: 2,
      stream_id: requests[0].params.stream_id,
    });
    expect(JSON.stringify(result)).not.toContain(requests[0].params.chunk_data);
  });

  it('attempts to reset the remote upload stream after a chunk failure and preserves the original stage error', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'payload.bin');
    fs.writeFileSync(inputFile, Buffer.alloc(600 * 1024, 7));
    const requests: Array<Record<string, any>> = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, any>;
      requests.push(request);
      let frame: Record<string, unknown>;
      if (request.params.reset) {
        frame = { status: 'failed', retcode: 100, wording: 'Stream reset completed', data: { type: 'error', data_type: 'error' } };
      } else if (request.params.chunk_index === 1) {
        frame = { status: 'failed', retcode: 100, wording: 'disk full', data: { type: 'error', data_type: 'error' } };
      } else {
        frame = { status: 'ok', retcode: 0, data: { type: 'stream', status: 'chunk_received', received_chunks: 1, total_chunks: 2 } };
      }
      return new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    await expect(client.callStream('upload_file_stream', {}, { inputFile })).rejects.toThrow(/upload_file_stream.*send chunk 1.*disk full/i);
    expect(requests.at(-1)?.params).toMatchObject({ stream_id: requests[0].params.stream_id, reset: true });
  });

  it('adds action and request-stage context to a stream transport failure', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('test_download_stream', {})).rejects.toThrow(/action test_download_stream.*connection.*ECONNREFUSED/i);
  });

  it('fails fast when automatic-upload params conflict with MCP-owned transfer fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'empty.bin');
    fs.writeFileSync(inputFile, '');
    let fetchCalls = 0;
    const fakeFetch = (async () => { fetchCalls++; throw new Error('fetch must not run'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    await expect(client.callStream('upload_file_stream', { stream_id: 'caller-owned', chunk_data: 'YQ==' }, { inputFile }))
      .rejects.toThrow(/upload_file_stream.*prepare upload.*conflict.*stream_id.*chunk_data/i);
    expect(fetchCalls).toBe(0);
  });

  it('uploads an empty file as one empty chunk followed by explicit completion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'empty.bin');
    fs.writeFileSync(inputFile, '');
    const sha256 = createHash('sha256').update('').digest('hex');
    const requests: Array<Record<string, any>> = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, any>;
      requests.push(request);
      const data = request.params.is_complete
        ? { type: 'response', status: 'file_complete', file_path: '/remote/empty.bin', file_size: 0, sha256 }
        : { type: 'stream', status: 'chunk_received', received_chunks: 1, total_chunks: 1 };
      return new Response(`${JSON.stringify({ status: 'ok', retcode: 0, data })}\r\n\r\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    const result = await client.callStream('upload_file_stream', {}, { inputFile });

    expect(requests).toHaveLength(2);
    expect(requests[0].params).toMatchObject({ chunk_data: '', chunk_index: 0, total_chunks: 1, file_size: 0 });
    expect(requests[1].params).toMatchObject({ is_complete: true, expected_sha256: sha256 });
    expect(result).toMatchObject({ file_path: '/remote/empty.bin', file_size: 0, sha256, chunk_count: 1 });
  });

  it('rejects an upload input that resolves to a directory before any network call', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    const dir = path.join(root, 'nested');
    fs.mkdirSync(dir);
    tempDirs.push(root);
    let fetchCalls = 0;
    const fakeFetch = (async () => { fetchCalls++; throw new Error('fetch must not run'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    await expect(client.callStream('upload_file_stream', {}, { inputFile: dir })).rejects.toThrow(/upload_file_stream.*open input.*not a regular file/i);
    expect(fetchCalls).toBe(0);
  });

  it('reports a failed best-effort remote reset instead of silently dropping it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'one.bin');
    fs.writeFileSync(inputFile, 'x');
    let calls = 0;
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      const request = JSON.parse(String(init.body)) as Record<string, any>;
      if (request.params.reset) throw new Error('reset connection lost');
      const frame = { status: 'failed', retcode: 100, wording: 'chunk rejected', data: { type: 'error' } };
      return new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root });

    await expect(client.callStream('upload_file_stream', {}, { inputFile }))
      .rejects.toThrow(/send chunk 0.*chunk rejected.*remote reset failed.*reset connection lost/i);
    expect(calls).toBe(2);
  });

  it('rejects file_info whose declared chunk geometry exceeds the 200000-frame file cap', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const frame = {
      status: 'ok', retcode: 0,
      data: { type: 'stream', data_type: 'file_info', file_name: 'tiny-chunks.bin', file_size: 200_001, chunk_size: 1 },
    };
    const fakeFetch = (async () => new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/frame 0.*file chunks.*200000/i);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('treats file_size=0 as unknown and commits a non-empty download using terminal.total_bytes', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const content = Buffer.from('unknown-size payload');
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'unknown.bin', file_size: 0, chunk_size: 65536 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: content.length, data: content.toString('base64') } },
      { status: 'ok', retcode: 0, data: { type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: content.length } },
    ];
    const fakeFetch = (async () => new Response(frames.map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join(''), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir });

    const result = await client.callStream('download_file_stream', {});

    expect(result.file_size).toBe(content.length);
    expect(fs.readFileSync(result.file_path).equals(content)).toBe(true);
  });

  it('requires file_info as the first successful frame for known file-download actions', async () => {
    const frame = { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'unexpected' } };
    const fakeFetch = (async () => new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download_file_stream.*frame 0.*first.*file_info/i);
  });

  it('never treats file_chunk or file_complete without file_info as a generic frame summary', async () => {
    for (const dataType of ['file_chunk', 'file_complete']) {
      const secret = Buffer.from(`secret-${dataType}`).toString('base64');
      const frame = { status: 'ok', retcode: 0, data: { type: 'stream', data_type: dataType, data: secret } };
      const fakeFetch = (async () => new Response(`${JSON.stringify(frame)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
      const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });

      let message = '';
      try { await client.callStream('test_download_stream', {}); } catch (error) { message = String(error); }
      expect(message).toMatch(/frame 0.*without file_info/i);
      expect(message).not.toContain(secret);
    }
  });

  it('cancels an in-flight download from the MCP signal and removes its partial file', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const prefix = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'cancel.bin', file_size: 6, chunk_size: 3 } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_chunk', index: 0, size: 3, data: Buffer.from('abc').toString('base64') } },
    ].map((frame) => `${JSON.stringify(frame)}\r\n\r\n`).join('');
    let bodyCancelled = false;
    const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prefix)); },
      cancel() { bodyCancelled = true; },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = client.callStream('download_file_stream', {}, { signal: controller.signal });

    for (let i = 0; i < 50 && !fs.readdirSync(streamDir).some((name) => name.endsWith('.part')); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    controller.abort(new Error('MCP caller cancelled'));
    const outcome = await Promise.race([
      pending.then((value) => ({ value }), (error) => ({ error })),
      new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), 250)),
    ]);

    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(/download_file_stream.*cancel.*MCP caller cancelled/i);
    expect(bodyCancelled).toBe(true);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('resets the idle deadline after every frame instead of imposing an overall stream timeout', async () => {
    const frames = [
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'one' } },
      { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'data_chunk', data: 'two' } },
      { status: 'ok', retcode: 0, data: { type: 'response', data_type: 'data_complete', data: 'done' } },
    ];
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timers = frames.map((frame, index) => setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\r\n\r\n`));
            if (index === frames.length - 1) controller.close();
          }, [10, 35, 65][index]));
          signal.addEventListener('abort', () => {
            for (const timer of timers) clearTimeout(timer);
            controller.error(signal.reason);
          }, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, timeoutMs: 40 });

    const result = await client.callStream('test_download_stream', {});

    expect(result).toMatchObject({ frame_count: 3, terminal: frames[2] });
  });

  it('cancels a stalled body at the per-read idle deadline and removes the partial file', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-client-'));
    tempDirs.push(streamDir);
    const info = { status: 'ok', retcode: 0, data: { type: 'stream', data_type: 'file_info', file_name: 'idle.bin', file_size: 4, chunk_size: 4 } };
    let cancelled = false;
    const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(info)}\r\n\r\n`)); },
      cancel() { cancelled = true; },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir, timeoutMs: 20 });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download_file_stream.*idle timeout.*20ms/i);
    expect(cancelled).toBe(true);
    expect(fs.readdirSync(streamDir)).toEqual([]);
  });

  it('propagates upload cancellation but performs remote reset with an independent cleanup signal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-root-'));
    tempDirs.push(root);
    const inputFile = path.join(root, 'cancel-upload.bin');
    fs.writeFileSync(inputFile, 'x');
    const requests: Array<Record<string, any>> = [];
    const signals: AbortSignal[] = [];
    let markUploadRequestStarted!: () => void;
    const uploadRequestStarted = new Promise<void>((resolve) => {
      markUploadRequestStarted = resolve;
    });
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, any>;
      requests.push(request);
      signals.push(init.signal as AbortSignal);
      if (request.params.reset) {
        const reset = { status: 'failed', retcode: 100, wording: 'Stream reset completed', data: { type: 'error' } };
        return new Response(`${JSON.stringify(reset)}\r\n\r\n`, { status: 200 });
      }
      markUploadRequestStarted();
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, uploadRoot: root, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = client.callStream('upload_file_stream', {}, { inputFile, signal: controller.signal });
    await uploadRequestStarted;

    controller.abort(new Error('cancel automatic upload'));
    const outcome = await Promise.race([
      pending.then((value) => ({ value }), (error) => ({ error })),
      new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), 250)),
    ]);

    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(/upload_file_stream.*cancel automatic upload/i);
    expect(requests.at(-1)?.params).toMatchObject({ reset: true, stream_id: requests[0].params.stream_id });
    expect(signals).toHaveLength(2);
    expect(signals[1]).not.toBe(controller.signal);
    expect(signals[1].aborted).toBe(false);
  });

  it('limits each client to four top-level active Stream Actions', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fakeFetch = (async () => new Promise<Response>((resolve) => { resolvers.push(resolve); })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, timeoutMs: 1_000 });
    const active = Array.from({ length: 4 }, () => client.callStream('test_download_stream', {}));
    const fifth = client.callStream('test_download_stream', {});
    const fifthOutcomePromise = fifth.then((value) => ({ value }), (error) => ({ error }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedRequests = resolvers.length;
    const terminal = { status: 'ok', retcode: 0, data: { type: 'response', data_type: 'data_complete' } };
    for (const resolve of resolvers) {
      resolve(new Response(`${JSON.stringify(terminal)}\r\n\r\n`, { status: 200 }));
    }
    const fifthOutcome = await fifthOutcomePromise;
    await Promise.all(active);

    expect(startedRequests).toBe(4);
    expect(fifthOutcome).toHaveProperty('error');
    expect(String('error' in fifthOutcome ? fifthOutcome.error : '')).toMatch(/active Stream Action.*limit.*4/i);
  });

  it('enforces the download-directory quota and reserves maxStreamBytes for unknown-size files', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-quota-'));
    tempDirs.push(streamDir);
    fs.writeFileSync(path.join(streamDir, 'existing.bin'), Buffer.alloc(11));
    const info = {
      status: 'ok', retcode: 0,
      data: { type: 'stream', data_type: 'file_info', file_name: 'unknown.bin', file_size: 0, chunk_size: 4 },
    };
    const fakeFetch = (async () => new Response(`${JSON.stringify(info)}\r\n\r\n`, { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir, maxStreamBytes: 10 });

    await expect(client.callStream('download_file_stream', {})).rejects.toThrow(/download directory quota.*20.*existing.*11.*reserve.*10/i);
    expect(fs.readdirSync(streamDir)).toEqual(['existing.bin']);
  });

  it('includes in-process reservations when admitting concurrent downloads', async () => {
    const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-quota-'));
    tempDirs.push(streamDir);
    fs.writeFileSync(path.join(streamDir, 'existing.bin'), Buffer.alloc(1));
    const info = {
      status: 'ok', retcode: 0,
      data: { type: 'stream', data_type: 'file_info', file_name: 'pending.bin', file_size: 0, chunk_size: 4 },
    };
    const fakeFetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(info)}\r\n\r\n`)); },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch, streamDir, maxStreamBytes: 10, timeoutMs: 1_000 });
    const firstController = new AbortController();
    const first = client.callStream('download_file_stream', { id: 1 }, { signal: firstController.signal });
    const firstOutcome = first.then((value) => ({ value }), (error) => ({ error }));
    for (let i = 0; i < 50 && !fs.readdirSync(streamDir).some((name) => name.endsWith('.part')); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await expect(client.callStream('download_file_stream', { id: 2 })).rejects.toThrow(/quota.*reserved=10.*reserve=10/i);
    firstController.abort(new Error('test cleanup'));
    await firstOutcome;
    expect(fs.readdirSync(streamDir)).toEqual(['existing.bin']);
  });
});
