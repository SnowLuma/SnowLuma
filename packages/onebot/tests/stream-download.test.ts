// Phase 3 — download stream actions (#163): server-push multi-frame.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import { __test } from '../src/actions/stream-download';
import { STREAM_DOWNLOAD_DIR, __test as fileTest } from '../src/actions/stream-file';

const parse = (frames: string[]) => frames.map((f) => JSON.parse(f) as Record<string, any>);

afterEach(() => {
  fileTest.cleanDir(STREAM_DOWNLOAD_DIR);
});

describe('test_download_stream', () => {
  it('pushes 10 data frames then a data_complete terminal', async () => {
    const h = new ApiHandler({} as ApiActionContext);
    expect(h.isStreamAction('test_download_stream')).toBe(true);

    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'test_download_stream', params: {}, echo: 'T' }), (j) => frames.push(j));

    const got = parse(frames);
    expect(got).toHaveLength(11);
    expect(got[0]).toMatchObject({ stream: 'stream-action', echo: 'T', data: { type: 'stream', data_type: 'data_chunk', data: 'Index-> 1' } });
    expect(got[9]).toMatchObject({ data: { data: 'Index-> 10' } });
    expect(got[10]).toMatchObject({ status: 'ok', data: { type: 'response', data_type: 'data_complete', data: 'Stream transmission complete' } });
  });

  it('error=true streams the 10 frames then terminates with an error frame', async () => {
    const h = new ApiHandler({} as ApiActionContext);
    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'test_download_stream', params: { error: true } }), (j) => frames.push(j));
    const got = parse(frames);
    expect(got).toHaveLength(11);
    expect(got[9]).toMatchObject({ data: { data_type: 'data_chunk' } });
    expect(got[10]).toMatchObject({ status: 'failed', data: { type: 'error' } });
  });
});

describe('download_file_stream (local, fenced)', () => {
  it('streams file_info → file_chunk* → file_complete and reassembles exactly', async () => {
    fs.mkdirSync(STREAM_DOWNLOAD_DIR, { recursive: true });
    const fp = path.join(STREAM_DOWNLOAD_DIR, 'dl.bin');
    const content = Buffer.from('snowluma stream download payload '.repeat(4000)); // ~128 KB → multiple 64 KB chunks
    fs.writeFileSync(fp, content);

    const h = new ApiHandler({} as ApiActionContext);
    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'download_file_stream', params: { file: fp, chunk_size: 65536 }, echo: 'D' }), (j) => frames.push(j));

    const got = parse(frames);
    expect(got[0]).toMatchObject({ stream: 'stream-action', echo: 'D', data: { data_type: 'file_info', file_name: 'dl.bin', file_size: content.length, chunk_size: 65536 } });

    const chunks = got.filter((p) => p.data?.data_type === 'file_chunk');
    expect(chunks.length).toBeGreaterThan(1);
    // indices are sequential and progress is monotonic
    chunks.forEach((c, i) => expect(c.data.index).toBe(i));

    const last = got[got.length - 1];
    expect(last).toMatchObject({ status: 'ok', data: { type: 'response', data_type: 'file_complete', total_bytes: content.length, total_chunks: chunks.length } });

    const reassembled = Buffer.concat(chunks.map((c) => Buffer.from(c.data.data, 'base64')));
    expect(reassembled.equals(content)).toBe(true);
  });

  it('refuses an arbitrary local path outside the stream root [arbitrary-read guard]', async () => {
    await expect(__test.resolveDownload('/etc/passwd', {} as ApiActionContext, 'auto', 65536)).rejects.toThrow(/restricted to the stream temp/i);
    await expect(__test.resolveDownload('file:///etc/hosts', {} as ApiActionContext, 'auto', 65536)).rejects.toThrow(/restricted to the stream temp/i);

    // and end-to-end the dispatch surfaces it as an error frame, not a leak
    const h = new ApiHandler({} as ApiActionContext);
    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'download_file_stream', params: { file: '/etc/passwd' } }), (j) => frames.push(j));
    expect(parse(frames).at(-1)).toMatchObject({ status: 'failed', data: { type: 'error' } });
  });
});

describe('SSRF guard', () => {
  it('classifies private/loopback/link-local addresses (incl. normalized v4-mapped IPv6) [C2]', () => {
    const priv = [
      '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0', '100.64.0.1',
      '::1', 'fc00::1', 'fd12::1', 'fe80::1',
      '::ffff:127.0.0.1', '::ffff:169.254.169.254',  // dotted v4-mapped
      '::ffff:7f00:1', '::ffff:a9fe:a9fe',            // hex v4-mapped (what `new URL` produces)
      '::127.0.0.1', '64:ff9b::7f00:1',               // v4-compatible, NAT64-mapped loopback
    ];
    for (const ip of priv) expect(__test.isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.4', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(__test.isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('rejects non-http(s) schemes and private/loopback URL targets — incl. v4-mapped literals [C1/C2]', async () => {
    await expect(__test.assertSafeUrl('ftp://example.com/x')).rejects.toThrow(/http\(s\)/i);
    await expect(__test.assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/http\(s\)/i);
    await expect(__test.assertSafeUrl('http://127.0.0.1/x')).rejects.toThrow(/private\/loopback/i);
    await expect(__test.assertSafeUrl('http://[::1]/x')).rejects.toThrow(/private\/loopback/i);
    // v4-mapped IPv6 literal → new URL normalizes hostname to hex; must still block
    await expect(__test.assertSafeUrl('http://[::ffff:127.0.0.1]/x')).rejects.toThrow(/private\/loopback/i);
    await expect(__test.assertSafeUrl('http://[::ffff:169.254.169.254]/meta')).rejects.toThrow(/private\/loopback/i);
    await expect(__test.assertSafeUrl('http://localhost/x')).rejects.toThrow(/private/i);
  });
});

describe('cached image/voice id resolution reaches the media branch [M1]', () => {
  it('a cache id flows past the local check to getImageInfo (then SSRF-guards its URL)', async () => {
    const ctx = {
      getImageInfo: async () => ({ url: 'http://10.0.0.7/cached.png', file: '', file_name: 'cached.png', file_size: '9' }),
      getRecordInfo: async () => null,
    } as unknown as ApiActionContext;
    // 'abc123.image' is not a real file → must NOT be rejected as "restricted";
    // it reaches getImageInfo, whose private URL is then blocked by the SSRF guard.
    await expect(__test.resolveDownload('abc123.image', ctx, 'image', 65536)).rejects.toThrow(/private/i);
  });
});
