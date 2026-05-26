import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { analyze, analyzeSource, selectUsedRegistry } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import protobufVitePlugin from '../../src/index';
import { replaceCallSites } from '../../src/transform/replacer';
import { execAndGet, loadFixture } from '../helpers';

describe('plugin integration', () => {
  it('full transform pipeline', () => {
    const code = loadFixture('real.ts');
    const registry = analyzeSource(code, 'real.ts');
    expect(registry.size).toBe(2);
    expect([...registry.keys()]).toEqual(['TestProtobuf', 'TestProtobufOutput']);

    const gen = generateCode(registry);
    expect(gen).toContain('protobuf_encode_TestProtobuf');
    expect(gen).toContain('protobuf_decode_TestProtobufOutput');

    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_TestProtobuf({ name: 123 })');
    expect(transformedCode).toContain('protobuf_decode_TestProtobufOutput(data)');
  });

  it('end-to-end round-trip', () => {
    const gen = generateCode(analyzeSource(loadFixture('real.ts'), 'real.ts'));
    const result = execAndGet<any>(gen + `\n
      const wr = protobuf_encode_TestProtobufOutput({ name: { name: 123 } });
      globalThis.__r = protobuf_decode_TestProtobufOutput(wr);
    `, '__r');
    expect(result.name.name).toBe(123);
  });

  it('wire format: TestProtobuf { name: 123 }', () => {
    const gen = generateCode(analyzeSource(loadFixture('real.ts'), 'real.ts'));
    const enc = execAndGet<Uint8Array>(gen + `\n
      globalThis.__r = protobuf_encode_TestProtobuf({ name: 123 });
    `, '__r');
    expect(enc.length).toBe(2);
    expect(enc[0]).toBe(0x08);
    expect(enc[1]).toBe(123);
  });

  it('wire format: nested message', () => {
    const gen = generateCode(analyzeSource(loadFixture('real.ts'), 'real.ts'));
    const enc = execAndGet<Uint8Array>(gen + `\n
      globalThis.__r = protobuf_encode_TestProtobufOutput({ name: { name: 456 } });
    `, '__r');
    expect(enc[0]).toBe(0x0a);
    expect(enc[1]).toBe(3);
    expect(enc[2]).toBe(0x08);
    expect(enc[3]).toBe(0xc8);
    expect(enc[4]).toBe(0x03);
  });

  it('multi-field round-trip', () => {
    const gen = generateCode(analyzeSource(loadFixture('multi-field.ts'), 't.ts'));
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_UserProfile({ id: 42, username: "alice", active: true });
      globalThis.__r = protobuf_decode_UserProfile(enc);
    `, '__r');
    expect(result.id).toBe(42);
    expect(result.username).toBe('alice');
    expect(result.active).toBe(true);
  });

  // ── generic monomorphization ───────────────────────────────────────

  it('generic monomorphization registry', () => {
    const registry = analyzeSource(loadFixture('generic-usage.ts'), 'g.ts');
    expect(registry.has('TestProtobufAny__string')).toBe(true);
    expect(registry.has('TestProtobufAny__TestProtobufAny__string')).toBe(true);
  });

  it('generic round-trip', () => {
    const gen = generateCode(analyzeSource(loadFixture('generic-usage.ts'), 'g.ts'));
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_TestProtobufAny__TestProtobufAny__string({ name: { name: "hello" } });
      globalThis.__r = protobuf_decode_TestProtobufAny__TestProtobufAny__string(enc);
    `, '__r');
    expect(result.name.name).toBe('hello');
  });

  // ── repeated fields ────────────────────────────────────────────────

  it('repeated fields round-trip', () => {
    const gen = generateCode(analyzeSource(loadFixture('repeated.ts'), 't.ts'));
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_RepeatedMsg({ ids: [10, 20, 30], names: ["foo", "bar"] });
      globalThis.__r = protobuf_decode_RepeatedMsg(enc);
    `, '__r');
    expect(result.ids).toEqual([10, 20, 30]);
    expect(result.names).toEqual(['foo', 'bar']);
  });

  it('repeated empty arrays', () => {
    const gen = generateCode(analyzeSource(loadFixture('repeated.ts'), 't.ts'));
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_RepeatedMsg({ ids: [], names: [] });
      globalThis.__r = protobuf_decode_RepeatedMsg(enc);
    `, '__r');
    expect(result.ids).toEqual([]);
    expect(result.names).toEqual([]);
  });

  // ── import-based usage ──────────────────────────────────────────────

  it('handles code with import { protobuf_encode } from "@snowluma/proton"', () => {
    const code = `
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

interface Msg { id: pb<1, uint_32>; }

const buf = protobuf_encode<Msg>({ id: 1 });
const decoded = protobuf_decode<Msg>(buf);
`;
    const registry = analyzeSource(code, 'import-test.ts');
    expect(registry.has('Msg')).toBe(true);

    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Msg(');
    expect(transformedCode).toContain('protobuf_decode_Msg(');
    // import line preserved
    expect(transformedCode).toContain("from '@snowluma/proton'");
  });

  it('import-based round-trip', () => {
    const code = `
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

interface Msg { id: pb<1, uint_32>; name: pb<2, string>; }

const buf = protobuf_encode<Msg>({ id: 42, name: 'test' });
const decoded = protobuf_decode<Msg>(buf);
`;
    const registry = analyzeSource(code, 'import-test.ts');
    const gen = generateCode(registry);
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_Msg({ id: 42, name: 'test' });
      globalThis.__r = protobuf_decode_Msg(enc);
    `, '__r');
    expect(result.id).toBe(42);
    expect(result.name).toBe('test');
  });

  it('runtime fallback throws error', async () => {
    const { protobuf_encode, protobuf_decode } = await import('../../src/runtime');
    expect(() => protobuf_encode({})).toThrow('not transformed');
    expect(() => protobuf_decode(new Uint8Array())).toThrow('not transformed');
  });

  // ── import rename alias ─────────────────────────────────────────────

  it('handles import { protobuf_encode as encode }', () => {
    const code = `
import { protobuf_encode as encode, protobuf_decode as decode } from '@snowluma/proton';

interface Msg { id: pb<1, uint_32>; }

const buf = encode<Msg>({ id: 1 });
const decoded = decode<Msg>(buf);
`;
    const registry = analyzeSource(code, 'alias-test.ts');
    expect(registry.has('Msg')).toBe(true);

    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Msg(');
    expect(transformedCode).toContain('protobuf_decode_Msg(');
    // alias calls replaced, import preserved
    expect(transformedCode).not.toContain('encode<Msg>');
    expect(transformedCode).not.toContain('decode<Msg>');
  });

  it('rename alias round-trip', () => {
    const code = `
import { protobuf_encode as enc } from '@snowluma/proton';

interface Item { val: pb<1, uint_32>; name: pb<2, string>; }

const buf = enc<Item>({ val: 99, name: 'x' });
`;
    const registry = analyzeSource(code, 'alias-rt.ts');
    const gen = generateCode(registry);
    const result = execAndGet<any>(gen + `\n
      const enc = protobuf_encode_Item({ val: 99, name: 'x' });
      globalThis.__r = protobuf_decode_Item(enc);
    `, '__r');
    expect(result.val).toBe(99);
    expect(result.name).toBe('x');
  });

  it('collects call roots first and generates only used dependency closure', () => {
    const code = `
import { protobuf_encode } from '@snowluma/proton';

interface Inner { id: pb<1, uint_32>; }
interface UsedMsg { inner: pb<1, Inner>; }
interface UnusedMsg { value: pb<1, string>; }

const buf = protobuf_encode<UsedMsg>({ inner: { id: 1 } });
`;

    const { registry, callSites, sourceFile } = analyze(code, 'used-only.ts');
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('UsedMsg')).toBe(true);
    expect(used.registry.has('Inner')).toBe(true);
    expect(used.registry.has('UnusedMsg')).toBe(false);

    const gen = generateCode(used.registry);
    expect(gen).toContain('protobuf_encode_UsedMsg');
    expect(gen).toContain('protobuf_encode_Inner');
    expect(gen).not.toContain('protobuf_encode_UnusedMsg');
  });

  it('respects the configured Vite transform scope root', () => {
    const scope = mkdtempSync(resolve(tmpdir(), 'proton-scope-'));
    try {
      const plugin = protobufVitePlugin({ root: scope, cache: false });
      const code = `interface Msg { id: pb<1, uint_32>; }\nconst buf = protobuf_encode<Msg>({ id: 1 });\n`;
      expect(runPluginTransform(plugin, code, resolve(tmpdir(), 'outside.ts'))).toBeNull();
      const inside = runPluginTransform(plugin, code, resolve(scope, 'inside.ts'));
      expect(inside?.code).toContain('protobuf_encode_Msg');
    } finally {
      rmSync(scope, { recursive: true, force: true });
    }
  });

  it('uses Vite cacheDir for transform hash cache', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'proton-cache-'));
    try {
      const sourcePath = resolve(root, 'entry.ts');
      const tsconfigPath = resolve(root, 'tsconfig.json');
      const cacheDir = resolve(root, '.vite');
      const code = `interface Msg { id: pb<1, uint_32>; }\nconst buf = protobuf_encode<Msg>({ id: 1 });\n`;
      writeFileSync(sourcePath, code);
      writeFileSync(tsconfigPath, JSON.stringify({
        compilerOptions: { noEmit: true, target: 'ES2022' },
        files: ['entry.ts'],
      }));

      const firstPlugin = protobufVitePlugin({ root });
      runConfigResolved(firstPlugin, root, cacheDir);
      const first = runPluginTransform(firstPlugin, code, sourcePath);
      expect(first?.code).toContain('protobuf_encode_Msg');

      const transformCacheDir = resolve(cacheDir, 'proton', 'transform');
      expect(existsSync(transformCacheDir)).toBe(true);
      expect(readdirSync(transformCacheDir).some(name => name.endsWith('.json'))).toBe(true);

      const secondPlugin = protobufVitePlugin({ root });
      runConfigResolved(secondPlugin, root, cacheDir);
      const second = runPluginTransform(secondPlugin, code, sourcePath);
      expect(second).toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

function runPluginTransform(
  plugin: ReturnType<typeof protobufVitePlugin>,
  code: string,
  id: string,
): { code: string; map: null } | null {
  const transformHook = plugin.transform!;
  const transformFn = typeof transformHook === 'function' ? transformHook : transformHook.handler;
  return transformFn.call({} as never, code, id) as { code: string; map: null } | null;
}

function runConfigResolved(plugin: ReturnType<typeof protobufVitePlugin>, root: string, cacheDir: string): void {
  const hook = plugin.configResolved!;
  const fn = typeof hook === 'function' ? hook : hook.handler;
  fn.call({} as never, { root, cacheDir } as never);
}
