import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../../src/ast/analyzer';
import { WireType } from '../../src/ast/types';
import { loadFixture } from '../helpers';

describe('AST analyzer', () => {
  it('collects TestProtobuf with correct fields', () => {
    const registry = analyzeSource(loadFixture('real.ts'), 'real.ts');
    const msg = registry.get('TestProtobuf')!;
    expect(msg).toBeDefined();
    expect(msg.fields).toHaveLength(1);
    expect(msg.fields[0]).toMatchObject({ name: 'name', fieldNumber: 1, typeName: 'uint_32', isMessage: false });
  });

  it('collects nested message field', () => {
    const registry = analyzeSource(loadFixture('real.ts'), 'real.ts');
    const msg = registry.get('TestProtobufOutput')!;
    expect(msg.fields[0]).toMatchObject({ name: 'name', fieldNumber: 1, typeName: 'TestProtobuf', isMessage: true });
  });

  it('topological order: dependencies first', () => {
    const keys = [...analyzeSource(loadFixture('real.ts'), 'real.ts').keys()];
    expect(keys.indexOf('TestProtobuf')).toBeLessThan(keys.indexOf('TestProtobufOutput'));
  });

  it('skips generic interfaces (no call sites)', () => {
    expect(analyzeSource(loadFixture('generic-template.ts'), 'g.ts').size).toBe(0);
  });

  it('returns empty for non-pb interfaces', () => {
    expect(analyzeSource(loadFixture('no-pb.ts'), 'no.ts').size).toBe(0);
  });

  it('handles multiple fields', () => {
    const msg = analyzeSource(loadFixture('multi-field.ts'), 't.ts').get('UserProfile')!;
    expect(msg.fields).toHaveLength(3);
    expect(msg.fields[0]).toMatchObject({ name: 'id', fieldNumber: 1, typeName: 'uint_32' });
    expect(msg.fields[1]).toMatchObject({ name: 'username', fieldNumber: 2, typeName: 'string' });
    expect(msg.fields[2]).toMatchObject({ name: 'active', fieldNumber: 3, typeName: 'bool' });
  });

  it('collects repeated fields', () => {
    const msg = analyzeSource(loadFixture('repeated.ts'), 't.ts').get('RepeatedMsg')!;
    expect(msg.fields).toHaveLength(2);
    expect(msg.fields[0]).toMatchObject({ name: 'ids', fieldNumber: 1, typeName: 'uint_32', isRepeated: true });
    expect(msg.fields[1]).toMatchObject({ name: 'names', fieldNumber: 2, typeName: 'string', isRepeated: true });
  });

  it('monomorphizes generics from call sites', () => {
    const registry = analyzeSource(loadFixture('generic-usage.ts'), 'g.ts');
    expect(registry.has('TestProtobufAny__string')).toBe(true);
    expect(registry.has('TestProtobufAny__TestProtobufAny__string')).toBe(true);
  });

  // ── Edge cases (originally silently dropped / wrong wire type) ──────

  it('edge: monomorphizes a generic-instantiated field on a concrete interface', () => {
    // Regression: a concrete interface with `pb<N, Wrapper<T>>` previously
    // resolved the field's typeName to the bare identifier `"Wrapper"` and
    // never enqueued `Wrapper<T>` for monomorphization. The field was left
    // with the placeholder WireType.Varint, corrupting the wire format.
    const registry = analyzeSource(loadFixture('nested-generic-field.ts'), 'n.ts');

    expect(registry.has('Wrapper__uint_32')).toBe(true);

    const container = registry.get('Container')!;
    expect(container).toBeDefined();
    expect(container.fields[0]).toMatchObject({
      name: 'wrapped',
      fieldNumber: 5,
      typeName: 'Wrapper__uint_32',
      isMessage: true,
      wireType: WireType.LengthDelim,
    });
  });

  it('edge: monomorphizes a generic-instantiated field on a generic template', () => {
    // Regression: a generic template field typed as `pb<N, Wrapper<U>>` —
    // where `U` is the outer template's type param — was stored with the
    // mangled-but-unsubstituted name `'Wrapper__U'` and never re-instantiated
    // with the concrete substitution at monomorphization time. The field
    // ended up referencing `Wrapper__U` instead of `Wrapper__uint_32` and the
    // inner mangled instantiation was missing from the registry.
    const registry = analyzeSource(loadFixture('generic-with-generic-field.ts'), 'g.ts');

    expect(registry.has('Outer__uint_32')).toBe(true);
    expect(registry.has('Wrapper__uint_32')).toBe(true);

    const outer = registry.get('Outer__uint_32')!;
    expect(outer.fields[0]).toMatchObject({
      name: 'wrapped',
      fieldNumber: 5,
      typeName: 'Wrapper__uint_32',
      isMessage: true,
      wireType: WireType.LengthDelim,
    });

    const wrapper = registry.get('Wrapper__uint_32')!;
    expect(wrapper.fields[0]).toMatchObject({
      name: 'value',
      fieldNumber: 1,
      typeName: 'uint_32',
      isMessage: false,
    });
  });

  it('edge: throws when a field references an unresolved type name', () => {
    // Defensive guard: anything that escapes the analyzer's type tracking
    // (unions, intersections, mapped/conditional types, `Partial<T>`, etc.)
    // used to silently leak `WireType.Varint` into the codegen. Now it has
    // to fail loudly so future edge cases surface immediately.
    const source = `
      interface BadMsg {
        weird: pb<1, MissingType>;
      }
      const buf = protobuf_encode<BadMsg>({} as any);
    `;
    expect(() => analyzeSource(source, 'b.ts')).toThrow(/MissingType/);
  });

  it('edge: recognises aliased pb / pb_repeated marker imports', () => {
    // Regression: `parsePbTypeRef` compared the literal type-ref identifier
    // text against the constants `'pb'` / `'pb_repeated'`. With
    // `import { pb as P }` the text became `'P'`, so every field on the
    // interface was silently dropped and `Aliased` never made it into the
    // registry.
    const registry = analyzeSource(loadFixture('aliased-pb-marker.ts'), 'a.ts');

    const aliased = registry.get('Aliased')!;
    expect(aliased).toBeDefined();
    expect(aliased.fields).toHaveLength(2);
    expect(aliased.fields[0]).toMatchObject({
      name: 'id',
      fieldNumber: 1,
      typeName: 'uint_32',
      isRepeated: false,
    });
    expect(aliased.fields[1]).toMatchObject({
      name: 'tags',
      fieldNumber: 2,
      typeName: 'string',
      isRepeated: true,
    });
  });
});
