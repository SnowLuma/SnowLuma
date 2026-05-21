// Cross-package bare-specifier resolution.
//
// Companion to `cross-file.test.ts` — that suite covers relative-path
// imports between sibling files in the same package. Here we exercise
// the OTHER branch of `resolveModulePath`: a TypeScript-driven module
// resolution path that handles bare specifiers (`@scope/pkg`,
// `pkg-name`, …) so monorepo workspaces / npm packages can host proto
// definitions used from a different package.
//
// The motivating use case is decoupling `bridge/proto/proton/*.ts`
// from `@snowluma/core` into a standalone `@snowluma/proto-defs`
// package, so SnowLumaExtended (and any other consumer) can reuse the
// same wire definitions without copy-pasting them.
//
// The fixture is built in `os.tmpdir()` per-test-suite rather than
// committed to `test/fixtures/`. The reason: the resolution lookup
// has to find a real `node_modules/@fake/proto-defs/...` layout, and
// the repo-level `.gitignore` rule `**/node_modules/` would clobber a
// committed copy of that layout. A scratch tmpdir sidesteps the issue
// entirely and self-cleans in `afterAll`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { analyze, analyzeSource } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import { applyReplacements } from '../../src/transform/replacer';
import { resolveImports, type ParsedFileEntry } from '../../src/ast/import-resolver';
import { execAndGet } from '../helpers';

describe('cross-package import resolution (bare specifier)', () => {
  let tmpRoot: string;
  let consumerPath: string;

  beforeAll(() => {
    // Build a tiny fake monorepo layout:
    //
    //   <tmp>/
    //     consumer.ts                                  ← uses `import { RemoteMsg } from '@fake/proto-defs'`
    //     node_modules/
    //       @fake/
    //         proto-defs/
    //           package.json                           ← exports → ./src/index.ts
    //           src/
    //             index.ts                             ← exported interfaces
    //
    // Bundler-mode `ts.resolveModuleName` walks importer → parent
    // dirs looking for `node_modules`, so placing the consumer at
    // `<tmp>/consumer.ts` lets `<tmp>/node_modules/...` satisfy the
    // lookup.
    tmpRoot = mkdtempSync(join(tmpdir(), 'proton-cross-pkg-'));

    const pkgDir = resolve(tmpRoot, 'node_modules', '@fake', 'proto-defs');
    mkdirSync(resolve(pkgDir, 'src'), { recursive: true });

    // `exports."."` must point at a `.ts` source file — proton walks
    // interface AST nodes to collect `pb<…>` field tags, and a
    // generated `.d.ts` typically strips those generic args. Telling
    // consumers to ship source `.ts` is the same model
    // `@snowluma/proton` itself uses (`"default": "./src/runtime.ts"`).
    writeFileSync(
      resolve(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@fake/proto-defs',
        version: '1.0.0',
        type: 'module',
        main: './src/index.ts',
        types: './src/index.ts',
        exports: {
          '.': {
            types: './src/index.ts',
            default: './src/index.ts',
          },
        },
      }, null, 2),
    );

    writeFileSync(
      resolve(pkgDir, 'src', 'index.ts'),
      // proton's `collectInterface` recognises `pb<N, T>` as a marker
      // type by NAME — no actual import of `@snowluma/proton` is
      // needed for the fixture to parse. Matches the existing
      // cross-file fixtures (`fixtures/cross-file/types.ts` does the
      // same).
      'export interface RemoteMsg {\n' +
      '  id?:   pb<1, uint_32>;\n' +
      '  name?: pb<2, string>;\n' +
      '}\n',
    );

    consumerPath = resolve(tmpRoot, 'consumer.ts');
    writeFileSync(
      consumerPath,
      'import type { RemoteMsg } from \'@fake/proto-defs\';\n' +
      '\n' +
      'const buf = protobuf_encode<RemoteMsg>({ id: 42, name: \'alice\' });\n' +
      'const decoded = protobuf_decode<RemoteMsg>(buf);\n' +
      '\n' +
      'export { buf, decoded };\n',
    );
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collects interfaces from a `@fake/proto-defs` bare-specifier import', () => {
    // Smoke test: the import resolver MUST find the package and pick
    // up `RemoteMsg`. If this fails, `ts.resolveModuleName` likely
    // can't find the fake node_modules layout (check that the
    // BARE_SPECIFIER_COMPILER_OPTIONS in import-resolver.ts still
    // sets `moduleResolution: Bundler`).
    const code = readFileSync(consumerPath, 'utf-8');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, consumerPath, cache);

    expect(imported.concrete.some(m => m.name === 'RemoteMsg')).toBe(true);
  });

  it('rewrites encode/decode call sites against the imported type', () => {
    const code = readFileSync(consumerPath, 'utf-8');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, consumerPath, cache);

    const { registry, callSites, sourceFile } = analyze(code, consumerPath, imported);
    expect(registry.has('RemoteMsg')).toBe(true);

    const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_RemoteMsg');
    expect(transformedCode).toContain('protobuf_decode_RemoteMsg');
  });

  it('round-trips encode/decode of a bare-specifier-imported message', () => {
    // End-to-end: parse → analyze → generate codec → encode →
    // decode → assert payload survived. The same shape as
    // cross-file.test.ts's "Scenario A round-trip", but with the
    // type sourced from a separate package.
    const code = readFileSync(consumerPath, 'utf-8');
    const cache = new Map<string, ParsedFileEntry>();
    const imported = resolveImports(code, consumerPath, cache);
    const registry = analyzeSource(code, consumerPath, imported);
    const gen = generateCode(registry);

    const result = execAndGet<{ id: number; name: string }>(
      gen + '\n' +
      'const enc = protobuf_encode_RemoteMsg({ id: 42, name: \'alice\' });\n' +
      'globalThis.__r = protobuf_decode_RemoteMsg(enc);\n',
      '__r',
    );
    expect(result.id).toBe(42);
    expect(result.name).toBe('alice');
  });

  it('returns null for an unresolvable bare specifier (does not throw)', () => {
    // Pre-existing relative-path behavior: missing files return
    // null, never throw. The bare-specifier branch must match that
    // — otherwise a typo in a package name turns into a build crash
    // rather than a silent "no codec emitted" warning further down
    // the pipeline.
    const orphanPath = resolve(tmpRoot, 'orphan.ts');
    writeFileSync(
      orphanPath,
      'import type { Whatever } from \'@does-not-exist/nope\';\n' +
      'export type _ = Whatever;\n',
    );
    const code = readFileSync(orphanPath, 'utf-8');
    const cache = new Map<string, ParsedFileEntry>();
    // resolveImports swallows resolution failures by design — it
    // simply produces an empty `concrete` for the unresolvable
    // import. The assertion is that we got here without an exception.
    const imported = resolveImports(code, orphanPath, cache);
    expect(imported.concrete).toEqual([]);
  });
});
