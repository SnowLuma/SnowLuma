import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../../src/ast/analyzer';
import { replaceCallSites } from '../../src/transform/replacer';
import { loadFixture } from '../helpers';

describe('call-site replacer', () => {
  it('replaces protobuf_encode<T> with protobuf_encode_T', () => {
    const code = loadFixture('simple.ts') + `\nconst data = protobuf_encode<SimpleMsg>({ value: 1 });\n`;
    const registry = analyzeSource(code, 't.ts');
    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_SimpleMsg({ value: 1 })');
    expect(transformedCode).not.toContain('protobuf_encode<SimpleMsg>');
  });

  it('replaces protobuf_decode<T>', () => {
    const code = loadFixture('simple.ts') + `\nconst result = protobuf_decode<SimpleMsg>(data);\n`;
    const registry = analyzeSource(code, 't.ts');
    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_decode_SimpleMsg(data)');
  });

  it('replaces multiple calls', () => {
    const code = loadFixture('simple.ts') + `
const a = protobuf_encode<SimpleMsg>({ value: 1 });
const b = protobuf_decode<SimpleMsg>(a);
`;
    const registry = analyzeSource(code, 't.ts');
    const { transformedCode } = replaceCallSites(code, registry);
    expect(transformedCode).toContain('protobuf_encode_SimpleMsg({ value: 1 })');
    expect(transformedCode).toContain('protobuf_decode_SimpleMsg(a)');
  });

  it('preserves await keyword', () => {
    const code = loadFixture('simple.ts') + `\nconst a = await protobuf_encode<SimpleMsg>({ value: 1 });\n`;
    const registry = analyzeSource(code, 't.ts');
    const { transformedCode } = replaceCallSites(code, registry);
    expect(transformedCode).toContain('await protobuf_encode_SimpleMsg({ value: 1 })');
  });

  it('returns hasReplacements=false when no calls match', () => {
    const code = loadFixture('simple.ts') + `\nconst x = 123;\n`;
    const registry = analyzeSource(code, 't.ts');
    expect(replaceCallSites(code, registry).hasReplacements).toBe(false);
  });

  it('does not replace unknown type arguments', () => {
    const code = loadFixture('simple.ts') + `\nconst a = protobuf_encode<Unknown>({ v: 1 });\n`;
    const registry = analyzeSource(code, 't.ts');
    const { hasReplacements, transformedCode } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(false);
    expect(transformedCode).toContain('protobuf_encode<Unknown>');
  });

  it('replaces generic call-sites with mangled names', () => {
    const code = loadFixture('generic-usage.ts');
    const registry = analyzeSource(code, 't.ts');
    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('protobuf_encode_TestProtobufAny__TestProtobufAny__string');
    expect(transformedCode).toContain('protobuf_decode_TestProtobufAny__TestProtobufAny__string');
  });

  it('replaces namespace import calls', () => {
    const code = `
import * as pbx from '@snowluma/proton';

interface Msg { id: pb<1, uint_32>; }

const a = pbx.protobuf_encode<Msg>({ id: 1 });
const b = pbx.protobuf_decode<Msg>(a);
`;
    const registry = analyzeSource(code, 'ns.ts');
    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(true);
    expect(transformedCode).toContain('const a = protobuf_encode_Msg({ id: 1 });');
    expect(transformedCode).toContain('const b = protobuf_decode_Msg(a);');
  });

  it('does not replace same-name imports from non-runtime modules', () => {
    const code = `
import { protobuf_encode } from './other';

interface Msg { id: pb<1, uint_32>; }

const a = protobuf_encode<Msg>({ id: 1 });
`;
    const registry = analyzeSource(code, 'guard.ts');
    const { transformedCode, hasReplacements } = replaceCallSites(code, registry);
    expect(hasReplacements).toBe(false);
    expect(transformedCode).toContain('protobuf_encode<Msg>({ id: 1 })');
  });
});
