import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import native, { type NativeAddon, type ParserOptions } from '../src/native';

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(target: string) => boolean>(),
}));

const fsHooks = vi.hoisted(() => ({
  realExistsSync: (_target: string): boolean => false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsHooks.realExistsSync = (target) => actual.existsSync(target);
  existsSyncMock.mockImplementation((target) => actual.existsSync(target));
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      existsSyncMock(String(target)),
  };
});

const ORIGINAL_DEV_NO_NATIVE = process.env.SNOWLUMA_DEV_NO_NATIVE;
const ORIGINAL_CWD = process.cwd();
const NATIVE_SRC_DIR = path.dirname(fileURLToPath(new URL('../src/native.ts', import.meta.url)));
const BINARY_NAME = `websocket-${process.platform}-${process.arch}.node`;
const tmpDirs: string[] = [];

const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
const RFC_UNMASKED_HELLO = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
const RFC_MASKED_HELLO = Buffer.from([
  0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58,
]);
const RFC_MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
const HELLO = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);

const STUB_USE_SUFFIX =
  'Set SNOWLUMA_DEV_NO_NATIVE=0 (or unset) and provide the prebuilt binary to enable WebSocket I/O.';

let nativeIo = false;
try {
  nativeIo = native.computeAcceptKey(RFC_KEY) === RFC_ACCEPT;
} catch (err) {
  nativeIo = !String((err as Error).message).includes('native addon is stubbed');
}

function expectedSearchDirs(cwd = process.cwd()): string[] {
  return [
    path.resolve(NATIVE_SRC_DIR, 'native'),
    path.resolve(NATIVE_SRC_DIR, '..', 'native'),
    path.resolve(NATIVE_SRC_DIR, '..', '..', 'runtime', 'native'),
    path.resolve(cwd, 'native'),
    path.resolve(cwd, 'dist', 'native'),
    path.resolve(cwd, 'packages', 'runtime', 'native'),
  ];
}

function candidatePaths(cwd = process.cwd()): string[] {
  return expectedSearchDirs(cwd).map((dir) => path.join(dir, BINARY_NAME));
}

function notFoundMessage(cwd = process.cwd()): string {
  return `[snowluma/websocket] native addon not found: ${BINARY_NAME}. Searched: ${expectedSearchDirs(cwd).join(', ')}`;
}

function stubWarnMessage(reason: string): string {
  return `[snowluma/websocket] WARNING: using stub addon (${reason}). WebSocket features are disabled.`;
}

function stubUseMessage(reason: string): string {
  return `[snowluma/websocket] native addon is stubbed (${reason}). ${STUB_USE_SUFFIX}`;
}

function restoreExistsSync(): void {
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation((target) => fsHooks.realExistsSync(target));
}

function restoreDevNoNative(): void {
  if (ORIGINAL_DEV_NO_NATIVE === undefined) delete process.env.SNOWLUMA_DEV_NO_NATIVE;
  else process.env.SNOWLUMA_DEV_NO_NATIVE = ORIGINAL_DEV_NO_NATIVE;
}

async function loadNative(): Promise<NativeAddon> {
  return (await import('../src/native')).default;
}

function installFakeAddon(exports: NativeAddon): string[] {
  const opened: string[] = [];
  vi.spyOn(process, 'dlopen').mockImplementation((module, filename) => {
    opened.push(filename);
    module.exports = exports;
  });
  return opened;
}

function fakeAddon(acceptKey: string): NativeAddon {
  return {
    Parser: class {
      push() {
        return { frames: [] };
      }
    } as unknown as NativeAddon['Parser'],
    buildFrame: () => Buffer.from([0x81, 0x00]),
    computeAcceptKey: () => acceptKey,
  };
}

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sl-ws-native-'));
  tmpDirs.push(dir);
  return dir;
}

function cleanupLoaderTest(): void {
  process.chdir(ORIGINAL_CWD);
  restoreDevNoNative();
  restoreExistsSync();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

describe.skipIf(!nativeIo)('computeAcceptKey', () => {
  it('returns the RFC 6455 §1.3 Sec-WebSocket-Accept value', () => {
    expect(native.computeAcceptKey(RFC_KEY)).toBe(RFC_ACCEPT);
  });

  it('rejects a non-string key', () => {
    expect(() => native.computeAcceptKey(1 as unknown as string)).toThrow('expected string');
  });
});

describe.skipIf(!nativeIo)('buildFrame', () => {
  it('emits the RFC 6455 §5.7 unmasked Hello text frame', () => {
    expect(native.buildFrame(0x1, true, HELLO, null, 0)).toEqual(RFC_UNMASKED_HELLO);
  });

  it('emits the RFC 6455 §5.7 masked Hello text frame', () => {
    expect(native.buildFrame(0x1, true, HELLO, RFC_MASK, 0)).toEqual(RFC_MASKED_HELLO);
  });

  it('encodes a 16-bit length for a 126-byte payload', () => {
    const payload = Buffer.alloc(126, 0x55);
    expect(native.buildFrame(0x2, true, payload, null, 0)).toEqual(
      Buffer.concat([Buffer.from([0x82, 0x7e, 0x00, 0x7e]), payload]),
    );
  });

  it('encodes a 64-bit length for a 65536-byte payload', () => {
    const payload = Buffer.alloc(65536, 0x62);
    expect(native.buildFrame(0x2, true, payload, null, 0)).toEqual(
      Buffer.concat([
        Buffer.from([0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
        payload,
      ]),
    );
  });

  it('masks a 16-bit-length payload with the 4-byte key', () => {
    const payload = Buffer.alloc(126, 0x55);
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
    expect(native.buildFrame(0x2, true, payload, mask, 0)).toEqual(
      Buffer.concat([Buffer.from([0x82, 0xfe, 0x00, 0x7e, 0x01, 0x02, 0x03, 0x04]), body]),
    );
  });

  it('writes FIN, RSV, and opcode into the first header byte', () => {
    expect(native.buildFrame(0x1, false, Buffer.from([0x48, 0x65, 0x6c]), null, 0)).toEqual(
      Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]),
    );
    expect(native.buildFrame(0x1, true, Buffer.alloc(0), null, 0x40)).toEqual(Buffer.from([0xc1, 0x00]));
    expect(native.buildFrame(0x11, true, Buffer.alloc(0), null, 0x41)).toEqual(Buffer.from([0xc1, 0x00]));
    expect(native.buildFrame(0x8, true, Buffer.from([0x03, 0xe8]), null, 0)).toEqual(
      Buffer.from([0x88, 0x02, 0x03, 0xe8]),
    );
    expect(native.buildFrame(0x9, true, Buffer.alloc(0), null, 0)).toEqual(Buffer.from([0x89, 0x00]));
  });

  it('rejects a mask key that is not 4 bytes', () => {
    expect(() => native.buildFrame(0x1, true, HELLO, Buffer.from([0x00, 0x01, 0x02]), 0)).toThrow(
      'mask key must be 4 bytes',
    );
  });

  it('rejects a call that is missing the required arguments', () => {
    expect(() =>
      (native.buildFrame as unknown as (opcode: number) => Buffer)(0x1),
    ).toThrow('bad args');
  });
});

describe.skipIf(!nativeIo)('Parser', () => {
  it('parses the RFC 6455 unmasked Hello frame as a client', () => {
    const parser = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0 });
    expect(parser.push(RFC_UNMASKED_HELLO)).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x1, payload: HELLO }],
    });
  });

  it('unmasks the RFC 6455 masked Hello frame as a server', () => {
    const parser = new native.Parser({ isServer: true, maxPayload: 1024, allowedRsv: 0 });
    expect(parser.push(RFC_MASKED_HELLO)).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x1, payload: HELLO }],
    });
  });

  it('returns no frames until a split header and payload are complete', () => {
    const parser = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0 });
    expect(parser.push(Buffer.from([0x81]))).toEqual({ frames: [] });
    expect(parser.push(Buffer.from([0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x1, payload: HELLO }],
    });
  });

  it('parses two frames from one chunk', () => {
    const parser = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0 });
    expect(parser.push(Buffer.concat([
      RFC_UNMASKED_HELLO,
      Buffer.from([0x89, 0x00]),
    ]))).toEqual({
      frames: [
        { fin: true, rsv: 0, opcode: 0x1, payload: HELLO },
        { fin: true, rsv: 0, opcode: 0x9, payload: Buffer.alloc(0) },
      ],
    });
  });

  it('parses 16-bit and 64-bit unmasked payloads', () => {
    const mid = Buffer.alloc(126, 0x41);
    const large = Buffer.alloc(65536, 0x42);
    const midParser = new native.Parser({ isServer: false, maxPayload: 200, allowedRsv: 0 });
    expect(midParser.push(Buffer.concat([Buffer.from([0x82, 0x7e, 0x00, 0x7e]), mid]))).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x2, payload: mid }],
    });
    const largeParser = new native.Parser({ isServer: false, maxPayload: 70_000, allowedRsv: 0 });
    expect(largeParser.push(Buffer.concat([
      Buffer.from([0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]),
      large,
    ]))).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x2, payload: large }],
    });
  });

  it('exposes allowed RSV1 and defaults to a masking server', () => {
    const deflate = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0x40 });
    expect(deflate.push(Buffer.from([0xc1, 0x00]))).toEqual({
      frames: [{ fin: true, rsv: 0x40, opcode: 0x1, payload: Buffer.alloc(0) }],
    });

    const defaults = new native.Parser({} as ParserOptions);
    expect(defaults.push(RFC_UNMASKED_HELLO)).toEqual({
      error: true,
      code: 1002,
      message: 'Expected masked frame from client',
    });
  });

  it('reports protocol errors with the native close code and message', () => {
    const client: ParserOptions = { isServer: false, maxPayload: 1, allowedRsv: 0 };
    expect(new native.Parser(client).push(Buffer.from([0xc1, 0x00]))).toEqual({
      error: true,
      code: 1002,
      message: 'Unexpected RSV bits',
    });
    expect(new native.Parser(client).push(Buffer.from([0x83, 0x00]))).toEqual({
      error: true,
      code: 1002,
      message: 'Unknown opcode',
    });
    expect(new native.Parser(client).push(Buffer.from([0x09, 0x00]))).toEqual({
      error: true,
      code: 1002,
      message: 'Fragmented control frame',
    });
    expect(new native.Parser(client).push(Buffer.from([0x89, 0x7e, 0x00, 0x7e]))).toEqual({
      error: true,
      code: 1002,
      message: 'Control frame too large',
    });
    expect(new native.Parser(client).push(Buffer.from([0x81, 0x80]))).toEqual({
      error: true,
      code: 1002,
      message: 'Server must not mask frames',
    });
    expect(new native.Parser(client).push(Buffer.from([0x82, 0x7e, 0x00, 0x05]))).toEqual({
      error: true,
      code: 1002,
      message: 'Non-minimal 16-bit length',
    });
    expect(new native.Parser(client).push(Buffer.from([
      0x82, 0x7f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05,
    ]))).toEqual({
      error: true,
      code: 1002,
      message: 'Non-minimal 64-bit length',
    });
    expect(new native.Parser(client).push(Buffer.from([
      0x82, 0x7f, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]))).toEqual({
      error: true,
      code: 1002,
      message: 'Payload length top bit set',
    });
    expect(new native.Parser(client).push(Buffer.from([0x82, 0x02]))).toEqual({
      error: true,
      code: 1009,
      message: 'Payload exceeds configured max',
    });

    expect(new native.Parser({ isServer: true, maxPayload: 1024, allowedRsv: 0 }).push(
      Buffer.from([0x81, 0x00]),
    )).toEqual({
      error: true,
      code: 1002,
      message: 'Expected masked frame from client',
    });

    expect(new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0x40 }).push(
      Buffer.from([0xc9, 0x00]),
    )).toEqual({
      error: true,
      code: 1002,
      message: 'Control frame RSV bits must be zero',
    });
  });

  it('treats a negative maxPayload as zero and masks allowedRsv to RSV bits', () => {
    const zeroCap = new native.Parser({ isServer: false, maxPayload: -1, allowedRsv: 0 });
    expect(zeroCap.push(Buffer.from([0x81, 0x00]))).toEqual({
      frames: [{ fin: true, rsv: 0, opcode: 0x1, payload: Buffer.alloc(0) }],
    });
    expect(zeroCap.push(Buffer.from([0x81, 0x01, 0x61]))).toEqual({
      error: true,
      code: 1009,
      message: 'Payload exceeds configured max',
    });

    const rsvMasked = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0x41 });
    expect(rsvMasked.push(Buffer.from([0xc1, 0x00]))).toEqual({
      frames: [{ fin: true, rsv: 0x40, opcode: 0x1, payload: Buffer.alloc(0) }],
    });
  });

  it('rejects a non-Buffer push argument', () => {
    const parser = new native.Parser({ isServer: false, maxPayload: 1024, allowedRsv: 0 });
    expect(() => parser.push('hello' as unknown as Buffer)).toThrow('expected Buffer');
  });
});

describe('addon path resolution', () => {
  beforeEach(() => {
    delete process.env.SNOWLUMA_DEV_NO_NATIVE;
    restoreExistsSync();
    vi.resetModules();
  });

  afterEach(cleanupLoaderTest);

  it('dlopens the first existing websocket-<platform>-<arch>.node candidate', async () => {
    const opened = installFakeAddon(fakeAddon('from-first-hit'));
    const winner = candidatePaths()[2]!;
    const probed: string[] = [];
    existsSyncMock.mockImplementation((target) => {
      probed.push(target);
      return target === winner;
    });

    const addon = await loadNative();
    expect(probed).toEqual(candidatePaths().slice(0, 3));
    expect(opened).toEqual([winner]);
    expect(addon.computeAcceptKey(RFC_KEY)).toBe('from-first-hit');
  });

  it('prefers the flattened <module>/native layout over later candidates', async () => {
    const opened = installFakeAddon(fakeAddon('flattened'));
    const winner = candidatePaths()[0]!;
    existsSyncMock.mockImplementation((target) => target === winner);

    await loadNative();
    expect(opened).toEqual([winner]);
    expect(existsSyncMock.mock.calls.map(([target]) => target)).toEqual([winner]);
  });

  it('falls back to process.cwd()/native when module-relative binaries are absent', async () => {
    process.chdir(makeTmpDir());
    // Node may report /private/var/folders/... after chdir while mkdtemp
    // returned /var/folders/...; searchDirs() uses process.cwd().
    const cwd = process.cwd();
    const opened = installFakeAddon(fakeAddon('cwd-native'));
    const winner = path.join(cwd, 'native', BINARY_NAME);
    existsSyncMock.mockImplementation((target) => target === winner);

    const addon = await loadNative();
    expect(opened).toEqual([winner]);
    expect(addon.computeAcceptKey(RFC_KEY)).toBe('cwd-native');
  });

  it('throws the searched-path error when no candidate exists', async () => {
    process.chdir(makeTmpDir());
    const cwd = process.cwd();
    const probed: string[] = [];
    existsSyncMock.mockImplementation((target) => {
      probed.push(target);
      return false;
    });

    let thrown: unknown;
    try {
      await loadNative();
    } catch (err) {
      thrown = err;
    }

    expect(probed).toEqual(candidatePaths(cwd));
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(notFoundMessage(cwd));
  });

  it('does not stub a successful load when SNOWLUMA_DEV_NO_NATIVE=1', async () => {
    process.env.SNOWLUMA_DEV_NO_NATIVE = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    existsSyncMock.mockImplementation((target) => target === candidatePaths()[0]);
    installFakeAddon(fakeAddon('still-live'));

    const addon = await loadNative();
    expect(warn).not.toHaveBeenCalled();
    expect(addon.computeAcceptKey(RFC_KEY)).toBe('still-live');
    expect(addon.buildFrame(0x1, true, Buffer.alloc(0), null, 0)).toEqual(Buffer.from([0x81, 0x00]));
  });
});

describe('SNOWLUMA_DEV_NO_NATIVE stub', () => {
  beforeEach(() => {
    delete process.env.SNOWLUMA_DEV_NO_NATIVE;
    restoreExistsSync();
    vi.resetModules();
  });

  afterEach(cleanupLoaderTest);

  it('stubs after a missing binary when the env var is exactly 1', async () => {
    process.env.SNOWLUMA_DEV_NO_NATIVE = '1';
    existsSyncMock.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const addon = await loadNative();
    const reason = notFoundMessage();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(stubWarnMessage(reason));

    const parser = new addon.Parser({ isServer: true, maxPayload: 1, allowedRsv: 0 });
    expect(() => parser.push(Buffer.alloc(0))).toThrow(stubUseMessage(reason));
    expect(() => addon.buildFrame(0x1, true, Buffer.alloc(0), null, 0)).toThrow(stubUseMessage(reason));
    expect(() => addon.computeAcceptKey(RFC_KEY)).toThrow(stubUseMessage(reason));
  });

  it('stubs after process.dlopen fails when the env var is exactly 1', async () => {
    process.env.SNOWLUMA_DEV_NO_NATIVE = '1';
    existsSyncMock.mockReturnValue(true);
    vi.spyOn(process, 'dlopen').mockImplementation(() => {
      throw new Error('not a valid Node addon');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const addon = await loadNative();
    expect(warn).toHaveBeenCalledWith(stubWarnMessage('not a valid Node addon'));
    expect(() => addon.computeAcceptKey(RFC_KEY)).toThrow(stubUseMessage('not a valid Node addon'));
  });

  it('rethrows a missing-binary error when the env var is not 1', async () => {
    existsSyncMock.mockReturnValue(false);
    for (const value of [undefined, '', '0', 'true', '2'] as const) {
      vi.resetModules();
      if (value === undefined) delete process.env.SNOWLUMA_DEV_NO_NATIVE;
      else process.env.SNOWLUMA_DEV_NO_NATIVE = value;

      let thrown: unknown;
      try {
        await loadNative();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(notFoundMessage());
    }
  });

  it('rethrows a dlopen failure when the env var is unset', async () => {
    existsSyncMock.mockReturnValue(true);
    vi.spyOn(process, 'dlopen').mockImplementation(() => {
      throw new Error('not a valid Node addon');
    });

    await expect(loadNative()).rejects.toThrow('not a valid Node addon');
  });
});
