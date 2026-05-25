import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { detectClassWrappersInFile } from '../../src/ast/static-wrapper';
import { renderSubclassOverride } from '../../src/codegen/subclass-override';
import protobufVitePlugin from '../../src/index';
import { runSubclassWrapperPipeline } from '../../src/typecheck/file-pipeline';
import { getProgramForFile, invalidateProgramCache } from '../../src/typecheck/program-cache';
import { WrapperLookupCache, resolveSubclassWrappers } from '../../src/typecheck/subclass-wrapper';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'wrapper-fixtures', 'packet-transformer.ts');

function loadFixture(): string {
  return readFileSync(fixturePath, 'utf-8');
}

describe('static-wrapper detection (AST)', () => {
  it('detects encode + decode wrappers on the abstract base', () => {
    const code = loadFixture();
    const sf = ts.createSourceFile(fixturePath, code, ts.ScriptTarget.Latest, true);
    const wrappers = detectClassWrappersInFile(sf);

    expect(wrappers.has('PacketTransformer')).toBe(true);
    const base = wrappers.get('PacketTransformer')!;
    expect(base.methods.has('encode')).toBe(true);
    expect(base.methods.has('decode')).toBe(true);

    const encode = base.methods.get('encode')!;
    expect(encode.typeParamNames).toContain('R');
    expect(encode.typeParamNames).toContain('T');
    expect(encode.codecCalls).toHaveLength(1);
    expect(encode.codecCalls[0]).toMatchObject({
      fnName: 'protobuf_encode',
      typeParamName: 'R',
    });

    const decode = base.methods.get('decode')!;
    expect(decode.codecCalls).toHaveLength(1);
    expect(decode.codecCalls[0]).toMatchObject({
      fnName: 'protobuf_decode',
      typeParamName: 'B',
    });
  });

  it('returns no wrappers for a class without protobuf type-param usage', () => {
    const code = `
class NotAWrapper {
  static helper<X>(value: X): X { return value; }
}
`;
    const sf = ts.createSourceFile('not-a-wrapper.ts', code, ts.ScriptTarget.Latest, true);
    const wrappers = detectClassWrappersInFile(sf);
    expect(wrappers.size).toBe(0);
  });
});

describe('subclass wrapper resolution (TypeChecker)', () => {
  it('resolves R for DemoTransformer.encode through the serialize return type', () => {
    invalidateProgramCache();
    const programCtx = getProgramForFile(fixturePath);
    if (!programCtx) {
      throw new Error('TypeChecker program unavailable for fixture');
    }
    const sf = programCtx.program.getSourceFile(fixturePath)!;
    expect(sf).toBeDefined();

    const subclass = sf.statements.find(
      (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'DemoTransformer',
    )!;

    const cache = new WrapperLookupCache();
    const resolved = resolveSubclassWrappers(subclass, sf, programCtx.checker, cache);
    expect(resolved).toHaveLength(2);

    const encode = resolved.find(r => r.wrapper.methodName === 'encode')!;
    expect(encode.resolvedCodecCalls).toHaveLength(1);
    expect(encode.resolvedCodecCalls[0]).toMatchObject({
      fnName: 'protobuf_encode',
      resolvedTypeName: 'rsq_pb',
    });

    const decode = resolved.find(r => r.wrapper.methodName === 'decode')!;
    expect(decode.resolvedCodecCalls).toHaveLength(1);
    expect(decode.resolvedCodecCalls[0]).toMatchObject({
      fnName: 'protobuf_decode',
      resolvedTypeName: 'rps_pb',
    });
  });

  it('renders the per-subclass override as JS-flavoured TS', () => {
    invalidateProgramCache();
    const programCtx = getProgramForFile(fixturePath)!;
    const sf = programCtx.program.getSourceFile(fixturePath)!;
    const subclass = sf.statements.find(
      (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'DemoTransformer',
    )!;

    const cache = new WrapperLookupCache();
    const resolved = resolveSubclassWrappers(subclass, sf, programCtx.checker, cache);
    const encode = resolved.find(r => r.wrapper.methodName === 'encode')!;
    const rendered = renderSubclassOverride(encode);
    expect(rendered).not.toBeNull();
    expect(rendered!.code).toContain('DemoTransformer.encode = function');
    expect(rendered!.code).toContain('protobuf_encode_rsq_pb');
    expect(rendered!.code).not.toContain('protobuf_encode<R>');
  });
});

describe('file-pipeline (end-to-end)', () => {
  function joinInsertionCode(insertions: { code: string }[]): string {
    return insertions.map(i => i.code).join('');
  }

  it('produces extra root names + override code for the demo subclass', () => {
    invalidateProgramCache();
    const result = runSubclassWrapperPipeline(fixturePath);

    expect(result.extraRootTypeNames).toEqual(
      expect.arrayContaining(['rsq_pb', 'rps_pb']),
    );
    const allOverride = joinInsertionCode(result.insertions);
    expect(allOverride).toContain('DemoTransformer.encode = function');
    expect(allOverride).toContain('DemoTransformer.decode = function');
    expect(allOverride).toContain('protobuf_encode_rsq_pb');
    expect(allOverride).toContain('protobuf_decode_rps_pb');
    // Per-subclass insertions land at exact source positions so the
    // override appears right after the subclass body, not at file end.
    expect(result.insertions.every(i => i.position > 0)).toBe(true);
  });

  it('returns an empty result when no class in the file extends a wrapper', () => {
    invalidateProgramCache();
    // Re-use an existing test file that has no transformer classes.
    const otherFile = resolve(here, 'plugin.test.ts');
    const result = runSubclassWrapperPipeline(otherFile);
    expect(result.resolvedWrappers).toHaveLength(0);
    expect(result.extraRootTypeNames).toHaveLength(0);
    expect(result.insertions).toHaveLength(0);
  });
});

describe('cross-file inheritance', () => {
  const subclassFile = resolve(here, 'wrapper-fixtures', 'subclass-transformer.ts');

  it('walks the extends edge into a separate module and resolves wrappers', () => {
    invalidateProgramCache();
    const result = runSubclassWrapperPipeline(subclassFile);
    expect(result.extraRootTypeNames).toEqual(
      expect.arrayContaining(['FooRequestPb', 'FooResponsePb']),
    );
    const allOverride = result.insertions.map(i => i.code).join('');
    expect(allOverride).toContain('FooTransformer.enc = function');
    expect(allOverride).toContain('FooTransformer.dec = function');
    expect(allOverride).toContain('protobuf_encode_FooRequestPb');
    expect(allOverride).toContain('protobuf_decode_FooResponsePb');
  });

  it('does not generate overrides on the abstract base file itself', () => {
    invalidateProgramCache();
    const baseFile = resolve(here, 'wrapper-fixtures', 'base-transformer.ts');
    const result = runSubclassWrapperPipeline(baseFile);
    // No subclasses defined in the base file → no overrides emitted there.
    expect(result.resolvedWrappers).toHaveLength(0);
    expect(result.insertions).toHaveLength(0);
  });
});

describe('plugin transform integration', () => {
  function runPluginOnFixture(): string {
    invalidateProgramCache();
    const plugin = protobufVitePlugin();
    const code = loadFixture();
    const transformHook = plugin.transform!;
    const transformFn = typeof transformHook === 'function' ? transformHook : transformHook.handler;
    const result = transformFn.call({} as never, code, fixturePath);
    return (result as { code: string }).code;
  }

  it('appends concrete codecs + per-subclass overrides to the fixture output', () => {
    const out = runPluginOnFixture();

    // Concrete codecs got generated for the types extracted from
    // serialize/deserialize annotations.
    expect(out).toContain('protobuf_encode_rsq_pb');
    expect(out).toContain('protobuf_decode_rps_pb');

    // Per-subclass overrides replace the inherited abstract bodies.
    expect(out).toContain('DemoTransformer.encode = function');
    expect(out).toContain('DemoTransformer.decode = function');

    // The original abstract body's `protobuf_encode<R>` form is left alone
    // (the analyzer skips type-param call-sites). It only appears once —
    // in the abstract method body — not in the generated override.
    const overrideMatches = out.match(/protobuf_encode<R>/g);
    expect(overrideMatches?.length).toBe(1);
  });

  /** Transpile the plugin output to plain ES2022, then strip the module
   *  syntax so `new Function()` can eval it. We use the ESNext module
   *  setting (rather than None / CJS, which would leak `exports`
   *  references the eval context doesn't have) and just delete the
   *  resulting `import` / `export` lines — exports are unused at this
   *  layer because we reach the class through its identifier, not through
   *  a module namespace. */
  function toPlainJs(tsOut: string): string {
    const jsOut = ts.transpileModule(tsOut, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return jsOut
      .replace(/^\s*import [^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '')
      .replace(/^export\s+(default\s+)?/gm, '$1')
      .replace(/^export\s+/gm, '');
  }

  it('end-to-end: DemoTransformer.encode(undefined, { param: 42 }) produces the expected wire bytes', () => {
    const stripped = toPlainJs(runPluginOnFixture());
    // Silence the `console.log` that the fixture's deserialize() performs;
    // we only verify the encode path in this test, but the fixture's
    // top-level call exercises encode, not decode, so the stub is just a
    // defensive measure against future fixture edits.
    const harness = `
      const console = { log: () => {} };
      ${stripped}
      const bytes = DemoTransformer.encode(undefined, { param: 42 });
      const decoded = protobuf_decode_rsq_pb(bytes);
      globalThis.__r = { bytes: Array.from(bytes), decoded };
    `;
    new Function(harness)();
    const r = (globalThis as unknown as { __r: { bytes: number[]; decoded: { param: number; id: number } } }).__r;
    delete (globalThis as unknown as { __r?: unknown }).__r;

    // serialize({ param: 42 }) → { param: 42, id: 123 }
    // rsq_pb declares `param: pb<3, int_32>` then `id: pb<1, int_32>`; the
    // generator emits fields in declaration order:
    //   field 3, varint, value 42  → tag 0x18, payload 0x2A
    //   field 1, varint, value 123 → tag 0x08, payload 0x7B
    expect(r.bytes).toEqual([0x18, 0x2a, 0x08, 0x7b]);
    expect(r.decoded).toEqual({ param: 42, id: 123 });
  });

  it('end-to-end: decode override forwards the bytes through deserialize', () => {
    const stripped = toPlainJs(runPluginOnFixture());

    const harness = `
      const console = { log: () => {} };
      ${stripped}
      // Build a response payload using the concrete encoder, then feed it
      // through the subclass's generated decode override.
      const responseBytes = protobuf_encode_rps_pb({ result: 7, id: 99 });
      globalThis.__r = DemoTransformer.decode(undefined, responseBytes);
    `;
    new Function(harness)();
    const r = (globalThis as unknown as { __r: { result: number } }).__r;
    delete (globalThis as unknown as { __r?: unknown }).__r;

    expect(r.result).toBe(7);
  });
});
