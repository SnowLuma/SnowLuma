import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { analyze, analyzeSource, selectUsedRegistry } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import { applyReplacements } from '../../src/transform/replacer';
import { resolveImports, type ParsedFileEntry } from '../../src/ast/import-resolver';
import { execAndGet } from '../helpers';

const crossDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cross-file');

function loadCross(name: string): { code: string; path: string } {
  const path = resolve(crossDir, name);
  return { code: readFileSync(path, 'utf-8'), path };
}

describe('cross-file import resolution', () => {
  // ── Scenario A: imported type in encode/decode call site ──────────

  it('resolves imported type for protobuf_encode/decode call site', () => {
    const { code, path } = loadCross('consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.concrete.some(m => m.name === 'UserMsg')).toBe(true);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    expect(registry.has('UserMsg')).toBe(true);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_UserMsg');
    expect(transformedCode).toContain('protobuf_decode_UserMsg');
  });

  it('Scenario A round-trip', () => {
    const { code, path } = loadCross('consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);
    const registry = analyzeSource(code, path, imported);
    const gen = generateCode(registry);

    const result = execAndGet<any>(gen + `\n
            const enc = protobuf_encode_UserMsg({ id: 42, name: 'alice' });
            globalThis.__r = protobuf_decode_UserMsg(enc);
        `, '__r');
    expect(result.id).toBe(42);
    expect(result.name).toBe('alice');
  });

  // ── Scenario B: imported type as pb<> field ──────────────────────

  it('resolves imported nested message type', () => {
    const { code, path } = loadCross('outer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.concrete.some(m => m.name === 'Inner')).toBe(true);

    const registry = analyzeSource(code, path, imported);
    expect(registry.has('Inner')).toBe(true);
    expect(registry.has('Outer')).toBe(true);

    const outer = registry.get('Outer')!;
    const innerField = outer.fields.find(f => f.name === 'inner')!;
    expect(innerField.isMessage).toBe(true);
  });

  it('Scenario B round-trip', () => {
    const { code, path } = loadCross('outer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);
    const registry = analyzeSource(code, path, imported);
    const gen = generateCode(registry);

    const result = execAndGet<any>(gen + `\n
            const enc = protobuf_encode_Outer({ inner: { value: 42 } });
            globalThis.__r = protobuf_decode_Outer(enc);
        `, '__r');
    expect(result.inner.value).toBe(42);
  });

  // ── Generic template import ──────────────────────────────────────

  it('resolves imported generic template', () => {
    const { code, path } = loadCross('generic-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.templates.has('Wrapper')).toBe(true);

    const registry = analyzeSource(code, path, imported);
    expect(registry.has('Wrapper__string')).toBe(true);
  });

  it('generic import round-trip', () => {
    const { code, path } = loadCross('generic-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);
    const registry = analyzeSource(code, path, imported);
    const gen = generateCode(registry);

    const result = execAndGet<any>(gen + `\n
            const enc = protobuf_encode_Wrapper__string({ value: 'hello' });
            globalThis.__r = protobuf_decode_Wrapper__string(enc);
        `, '__r');
    expect(result.value).toBe('hello');
  });

  it('resolves generic type passed through imported wrapper functions', () => {
    const { code, path } = loadCross('wrapper-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.templates.has('Wrapper')).toBe(true);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('Wrapper__string')).toBe(true);
    expect(used.callSites).toHaveLength(2);
    expect(used.callSites[0].fnName).toBe('protobuf_encode');
    expect(used.callSites[1].fnName).toBe('protobuf_decode');

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__string(');
  });

  it('handles wrapper aliases, arrows, nested generics, and non-first generic forwarding', () => {
    const { code, path } = loadCross('wrapper-edge-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('Wrapper__string')).toBe(true);
    expect(used.registry.has('Wrapper__Wrapper__string')).toBe(true);
    expect(used.callSites).toHaveLength(5);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_encode_Wrapper__Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__Wrapper__string(');
    expect(transformedCode).toContain('passthroughOnly<Wrapper<string>>');
  });

  it('handles local wrapper functions in the entry file', () => {
    const { code, path } = loadCross('local-wrapper-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('Wrapper__string')).toBe(true);
    expect(used.callSites).toHaveLength(2);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__string(');
  });

  it('handles complex wrapper objects, branches, nested helpers, and chains', () => {
    const { code, path } = loadCross('wrapper-complex-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('Wrapper__string')).toBe(true);
    expect(used.registry.has('Wrapper__Wrapper__string')).toBe(true);
    expect(used.callSites).toHaveLength(7);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_encode_Wrapper__Wrapper__string(');
    expect(transformedCode).not.toContain('encodeChained<Wrapper<string>>');
  });

  it('handles wrapper protobuf type derived from another generic type', () => {
    const { code, path } = loadCross('wrapper-type-source-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('Wrapper__string')).toBe(true);
    expect(used.registry.has('Wrapper__Wrapper__string')).toBe(true);
    expect(used.callSites).toHaveLength(5);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_decode_Wrapper__string(');
    expect(transformedCode).toContain('protobuf_encode_Wrapper__Wrapper__string(');
    expect(transformedCode).not.toContain('encodeBoxed<string>');
  });

  // ── Transitive imports ───────────────────────────────────────────

  it('resolves transitive imports (A → B → C)', () => {
    const { code, path } = loadCross('top.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.concrete.some(m => m.name === 'Mid')).toBe(true);
    expect(imported.concrete.some(m => m.name === 'Deep')).toBe(true);

    const registry = analyzeSource(code, path, imported);
    expect(registry.has('Top')).toBe(true);
    expect(registry.has('Mid')).toBe(true);
    expect(registry.has('Deep')).toBe(true);
  });

  it('transitive import round-trip', () => {
    const { code, path } = loadCross('top.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);
    const registry = analyzeSource(code, path, imported);
    const gen = generateCode(registry);

    const result = execAndGet<any>(gen + `\n
            const enc = protobuf_encode_Top({ nested: { inner: { val: 99 } } });
            globalThis.__r = protobuf_decode_Top(enc);
        `, '__r');
    expect(result.nested.inner.val).toBe(99);
  });

  // ── Cache behavior ───────────────────────────────────────────────

  it('uses cache on repeated resolves', () => {
    const { code, path } = loadCross('consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();

    resolveImports(code, path, cache);
    expect(cache.size).toBeGreaterThan(0);

    const cached = new Map(cache);
    resolveImports(code, path, cache);

    // Same entries, not re-created
    for (const [key, val] of cache) {
      expect(val).toBe(cached.get(key));
    }
  });

  // ── Graceful fallback ────────────────────────────────────────────

  it('handles missing import file gracefully', () => {
    const code = `import type { Ghost } from './nonexistent';\nconst x = 1;`;
    const fakePath = resolve(crossDir, 'fake.ts');
    const cache = new Map<string, ParsedFileEntry>();

    const imported = resolveImports(code, fakePath, cache);
    expect(imported.concrete).toEqual([]);
    expect(imported.templates.size).toBe(0);
  });

  it('only resolves imports reachable from protobuf call roots', () => {
    const code = `
import { protobuf_encode } from '@snowluma/proton';
import type { UserMsg } from './types';
import type { Inner } from './inner';

const buf = protobuf_encode<UserMsg>({ id: 42, name: 'alice' });
`;
    const fakePath = resolve(crossDir, 'on-demand.ts');
    const cache = new Map<string, ParsedFileEntry>();

    const imported = resolveImports(code, fakePath, cache);

    expect(imported.concrete.map(m => m.name)).toEqual(['UserMsg']);
    expect(cache.has(resolve(crossDir, 'types.ts'))).toBe(true);
    expect(cache.has(resolve(crossDir, 'inner.ts'))).toBe(false);
  });

  // ── Value import (non-type import) ───────────────────────────────

  it('resolves value import { SimpleMessage } (not import type)', () => {
    const { code, path } = loadCross('value-import-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    expect(imported.concrete.some(m => m.name === 'SimpleMessage')).toBe(true);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    expect(registry.has('SimpleMessage')).toBe(true);
    expect(callSites.length).toBe(2);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_SimpleMessage(');
    expect(transformedCode).toContain('protobuf_decode_SimpleMessage(');
  });

  it('value import round-trip', () => {
    const { code, path } = loadCross('value-import-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);
    const registry = analyzeSource(code, path, imported);
    const gen = generateCode(registry);

    const result = execAndGet<any>(gen + `\n
            const enc = protobuf_encode_SimpleMessage({ id: 42 });
            globalThis.__r = protobuf_decode_SimpleMessage(enc);
        `, '__r');
    expect(result.id).toBe(42);
  });

  it('canonicalizes imported type aliases to the original message name', () => {
    const { code, path } = loadCross('aliased-consumer.ts');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, path, cache);

    const { registry, callSites, sourceFile } = analyze(code, path, imported);
    const used = selectUsedRegistry(registry, callSites, sourceFile);

    expect(used.registry.has('UserMsg')).toBe(true);
    expect(used.registry.has('AliasMsg')).toBe(false);
    expect(used.callSites).toHaveLength(2);
    expect(used.callSites[0].typeName).toBe('UserMsg');
    expect(used.callSites[1].typeName).toBe('UserMsg');

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_UserMsg(');
    expect(transformedCode).toContain('protobuf_decode_UserMsg(');
    expect(transformedCode).not.toContain('protobuf_encode_AliasMsg(');
    expect(transformedCode).not.toContain('protobuf_decode_AliasMsg(');
  });
});
