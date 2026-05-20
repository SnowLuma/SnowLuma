import { describe, it, expect } from 'vitest';
import protobufVitePlugin from '../../src/index';
import { analyze, analyzeSource, selectUsedRegistry } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import { replaceCallSites } from '../../src/transform/replacer';
import { loadFixture, execAndGet } from '../helpers';

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

  it('emits runtime map asset when runtimeMap is enabled', () => {
    const code = `
import { protobuf_encode } from '@snowluma/proton';

interface Msg { id: pb<1, uint_32>; }
const buf = protobuf_encode<Msg>({ id: 1 });
`;

    const plugin = protobufVitePlugin({
      runtimeMap: {
        enabled: true,
        fileName: 'pb.runtime-map.json',
      },
    });

    const transformHook = plugin.transform!;
    const transform = typeof transformHook === 'function' ? transformHook : transformHook.handler;
    const transformResult = transform.call({} as any, code, 'entry.ts');
    expect(transformResult).toBeTruthy();

    const emitted: any[] = [];
    const generateHook = plugin.generateBundle!;
    const generateBundle = typeof generateHook === 'function' ? generateHook : generateHook.handler;
    const testContext: any = {
      emitFile(asset: any) {
        emitted.push(asset);
        return 'asset-id';
      },
    };

    generateBundle.call(
      testContext,
      {} as any,
      {} as any,
      false,
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('asset');
    expect(emitted[0].fileName).toBe('pb.runtime-map.json');

    const payload = JSON.parse(emitted[0].source);
    expect(payload.version).toBe(1);
    expect(payload.callSites).toHaveLength(1);
    expect(payload.callSites[0].fnName).toBe('protobuf_encode');
    expect(payload.callSites[0].typeName).toBe('Msg');
  });

  it('emits canonical runtime map entries for imported type aliases', () => {
    const code = `
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { UserMsg as AliasMsg } from './types';

const buf = protobuf_encode<AliasMsg>({ id: 1, name: 'a' });
const decoded = protobuf_decode<AliasMsg>(buf);
`;

    const plugin = protobufVitePlugin({
      runtimeMap: {
        enabled: true,
        fileName: 'pb.runtime-map.json',
      },
    });

    const transformHook = plugin.transform!;
    const transform = typeof transformHook === 'function' ? transformHook : transformHook.handler;
    const transformResult = transform.call({} as any, code, 'test/fixtures/cross-file/aliased-consumer.ts');
    expect(transformResult).toBeTruthy();

    const emitted: any[] = [];
    const generateHook = plugin.generateBundle!;
    const generateBundle = typeof generateHook === 'function' ? generateHook : generateHook.handler;
    const testContext: any = {
      emitFile(asset: any) {
        emitted.push(asset);
        return 'asset-id';
      },
    };

    generateBundle.call(testContext, {} as any, {} as any, false);

    expect(emitted).toHaveLength(1);
    const payload = JSON.parse(emitted[0].source);
    expect(payload.messages.some((msg: { name: string }) => msg.name === 'UserMsg')).toBe(true);
    expect(payload.messages.some((msg: { name: string }) => msg.name === 'AliasMsg')).toBe(false);
    expect(payload.callSites).toHaveLength(2);
    expect(payload.callSites[0].typeName).toBe('UserMsg');
    expect(payload.callSites[1].typeName).toBe('UserMsg');
  });
});
