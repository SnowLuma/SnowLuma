# @snowluma/proton

Compile-time protobuf encoder/decoder generator for SnowLuma. TypeScript
interfaces in, fully-inlined zero-runtime codec functions out.

> Vendored from [SnowLuma/protobuf-dsl](https://github.com/SnowLuma/protobuf-dsl)
> with edge-case fixes applied. The unmodified upstream is kept under
> `dev/protobuf-dsl/` as a reference copy.

## What it does

You declare your wire schema as plain TypeScript interfaces marked up with
`pb<N, T>`. At build time a Vite plugin walks the call sites of
`protobuf_encode<T>` / `protobuf_decode<T>` and replaces them with
type-specific, fully-inlined codec functions. No runtime schema lookup,
no reflection, no `.proto` files, no `protoc`.

```ts
import type { pb, pb_repeated, uint_32, bool } from '@snowluma/proton';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

interface UserProfile {
  id?:       pb<1, uint_32>;
  username?: pb<2, string>;
  active?:   pb<3, bool>;
  tags?:     pb_repeated<4, string>;
}

const bytes = protobuf_encode<UserProfile>({
  id: 42, username: 'alice', active: true, tags: ['admin'],
});
const user = protobuf_decode<UserProfile>(bytes);
```

After the plugin transform, this becomes:

```js
// pre-computed tag literals, inlined varint loops, no function-call overhead
const bytes = protobuf_encode_UserProfile({ id: 42, ... });
const user  = protobuf_decode_UserProfile(bytes);
```

If the plugin **isn't** installed, calling `protobuf_encode` / `protobuf_decode`
throws a loud error rather than silently producing wrong bytes.

## Setup in SnowLuma

The package is already wired into `@snowluma/core`'s `vitest.config.ts`. To use
it elsewhere in the monorepo:

```ts
// vite.config.ts (or vitest.config.ts)
import { defineConfig } from 'vite';
import protobufVitePlugin from '@snowluma/proton/vite';

export default defineConfig({
  plugins: [protobufVitePlugin()],
});
```

Add the workspace dep:

```json
{
  "dependencies": { "@snowluma/proton": "workspace:*" }
}
```

## Primitive types

The marker is `pb<FieldNumber, Type>` (or `pb_repeated<FieldNumber, Type>` for
arrays). Available primitives:

| Marker      | TS type      | Wire             |
| ----------- | ------------ | ---------------- |
| `bool`      | `boolean`    | varint           |
| `uint_32`   | `number`     | varint           |
| `int_32`    | `number`     | varint           |
| `sint_32`   | `number`     | varint (zigzag)  |
| `uint_64`   | `bigint`     | varint           |
| `int_64`    | `bigint`     | varint           |
| `sint_64`   | `bigint`     | varint (zigzag)  |
| `fixed_32`  | `number`     | 32-bit           |
| `fixed_64`  | `bigint`     | 64-bit           |
| `sfixed_32` | `number`     | 32-bit           |
| `sfixed_64` | `bigint`     | 64-bit           |
| `float`     | `number`     | 32-bit           |
| `double`    | `number`     | 64-bit           |
| `string`    | `string`     | length-delimited |
| `bytes`     | `Uint8Array` | length-delimited |

Plus message types (any other interface marked with `pb<>` fields) used as
the second type-arg to `pb<>` / `pb_repeated<>`.

## Generic templates

You can declare reusable wrappers as generic interfaces:

```ts
interface Wrapper<T> {
  value?: pb<1, T>;
}

const bytes = protobuf_encode<Wrapper<uint_32>>({ value: 42 });
//                              ^ instantiated at the call site
```

Nested instantiations work too — `Wrapper<Wrapper<string>>` mono-morphizes to
`Wrapper__string` + `Wrapper__Wrapper__string` and both end up in the registry
at build time.

Compose them in concrete interfaces:

```ts
interface Container {
  wrapped?: pb<5, Wrapper<uint_32>>;
}
```

…or in other generic templates:

```ts
interface Outer<U> {
  wrapped?: pb<5, Wrapper<U>>;
}
const bytes = protobuf_encode<Outer<uint_32>>({ wrapped: { value: 42 } });
```

Both forms are covered by regression tests.

## Cross-file & wrapper-binding

Schemas can live in one file and call sites in another:

```ts
// schema/user.ts
export interface UserProfile { id?: pb<1, uint_32>; }

// usage.ts
import type { UserProfile } from './schema/user';
import { protobuf_encode } from '@snowluma/proton';
const bytes = protobuf_encode<UserProfile>({ id: 42 });
```

You can also build thin generic wrappers around `protobuf_encode` / `_decode`
and the plugin will trace through them, including across file boundaries:

```ts
// schema/wrap.ts
export function encodeWrapped<T>(v: Wrapper<T>): Uint8Array {
  return protobuf_encode<Wrapper<T>>(v);
}

// usage.ts
import { encodeWrapped } from './schema/wrap';
const bytes = encodeWrapped<string>({ value: 'hi' });
//             ^ plugin rewrites to protobuf_encode_Wrapper__string(...)
```

Chained forwarders also work (`A` forwards to `B` which is imported from
another module, etc.).

## Static method wrappers (per-subclass overrides)

Sometimes you want an abstract base class to hold the encode / decode
pipeline once, with each subclass supplying only the request-/response-
shaped helpers:

```ts
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

abstract class PacketTransformer {
  static encode<R, T extends { serialize: (ctx: unknown, p: never) => R }>(
    this: T,
    ctx: unknown,
    params: T['serialize'] extends (ctx: unknown, p: infer P) => R ? P : never,
  ): Uint8Array {
    return protobuf_encode<R>((this as any).serialize(ctx, params));
  }

  static decode<B, Res, T extends { deserialize: (ctx: unknown, body: B) => Res }>(
    this: T,
    ctx: unknown,
    bytes: Uint8Array,
  ): Res {
    return (this as any).deserialize(ctx, protobuf_decode<B>(bytes));
  }
}

class DemoTransformer extends PacketTransformer {
  static serialize(_ctx: unknown, p: DemoReq): DemoReqPb { /* … */ }
  static deserialize(_ctx: unknown, b: DemoResPb): DemoRes { /* … */ }
}

// Just call the inherited methods naturally:
const bytes  = DemoTransformer.encode(undefined, { /* … */ });
const result = DemoTransformer.decode(undefined, bytes);
```

`protobuf_encode<R>` / `protobuf_decode<B>` inside the abstract body can't
be replaced statically — `R` and `B` are erased at runtime. Proton handles
this by:

1. Detecting any class whose static method (a) takes type parameters, (b)
   calls `protobuf_encode<R>` / `protobuf_decode<R>` where `R` is one of
   those parameters, and (c) constrains `this: T extends { … }` with the
   parameter appearing inside the constraint.
2. Using TypeScript's TypeChecker — built lazily from your project's
   `tsconfig.json` — to walk the `extends` chain for every subclass in the
   file (cross-file edges and path aliases included) and resolve the
   wrapper's type parameter against the subclass's sibling method
   signature (`serialize`'s return type for `R`, `deserialize`'s body
   parameter for `B`, in this example).
3. Appending a per-subclass override after the class declaration:

   ```js
   DemoTransformer.encode = function (ctx, params) {
     return protobuf_encode_DemoReqPb(this.serialize(ctx, params));
   };
   ```

The original call sites stay unmodified — runtime dispatch finds the
override naturally because static properties live on the constructor
function. The abstract base body is left intact too; nothing ever calls
it.

Naming is structural, not configured:

- The wrapper method can be named anything (`encode`, `enc`, `request`, …)
  — proton only looks at the body and constraint shape.
- The sibling method's name is read out of the `this: T extends { … }`
  constraint, so `serialize`/`deserialize`, `build`/`parse`, or any other
  pair works.
- Multi-level inheritance (`Leaf → MidBase → AbstractBase`) is followed
  end-to-end by the TypeChecker.

If the sibling method lacks an explicit return / parameter annotation the
checker's inferred type is used as a fallback. The override is only
emitted when every codec call in the wrapper body resolves successfully —
partial resolution would produce dead identifier references at runtime,
so the all-or-nothing rule is intentional.

## proto3 default-value semantics

**Important behavioural detail.** Proton follows the proto3 wire format spec:
fields whose value equals the type's default (`0` / `false` / `""` /
empty bytes) are **not emitted** on the wire. This is byte-different from
SnowLuma's legacy `protoEncode` runtime, which always emits every field.

Both forms are wire-compatible with any conforming proto3 reader (missing
fields decode as the default value). When migrating legacy schemas to proton,
do **not** treat byte-level inequality on default values as a regression — see
[`packages/core/tests/proton-parity.test.ts`](../../packages/core/tests/proton-parity.test.ts)
for the test that pins this divergence.

If you have a wire consumer that depends on byte-level identity (e.g. for
hashing or signing), prefer to set non-default values explicitly rather than
relying on the encoder.

## Diagnostics

Anything that doesn't resolve to a primitive or a registered message **throws
at build time** rather than silently leaking a wrong wire type:

```
Cannot resolve protobuf field type "Partial__UserProfile" on message "Foo"
(field "bar", field number 3). The analyzer did not produce a primitive or
registered message for this type. Common causes: union / intersection /
mapped / conditional types, TypeScript utility types (Partial<T>, Pick<T>, …),
qualified names (ns.Type), or a missing import.
```

This is the safety net for TypeScript constructs the analyzer doesn't model.
Currently unsupported:

- Union / intersection types (`A | B`, `A & B`)
- Conditional / mapped types (`T extends X ? A : B`, `{ [K in keyof T]: ... }`)
- TS utility types (`Partial<T>`, `Pick<T>`, `Readonly<T>`, …)
- Qualified type names (`ns.Type`)
- Wrapper functions reached via namespace import (`import * as ns from`)

…all of these will throw with a clear message instead of producing bad bytes.

## Edge cases fixed on top of upstream

Each has a regression test in `test/__tests__/analyzer.test.ts`:

| # | What used to break |
| - | --------------------- |
| 1 | `import { pb as P }` — aliased markers were ignored; fields dropped silently |
| 2 | `interface Foo { x: pb<1, Wrapper<uint_32>> }` — typeName stuck at `"Wrapper"`, no mono of the inner instantiation |
| 3 | `interface Outer<U> { x: pb<1, Wrapper<U>> }` — outer mono didn't re-instantiate the inner generic |
| 4 | Wrapper-binding synthetic SourceFile had empty text → `getText()` returned garbage |
| 5 | Cross-file forwarded wrappers (chain → imported base) not detected |
| 6 | `matchForwardedKnownWrapper` didn't propagate `typePattern` — chain treated `<X>` as the encoded type instead of `Wrapper<X>` |
| 7 | Synthetic-SF WeakMap was private to analyzer.ts → replacer used the wrong SF |

Plus the build-time guard (above) that turns future analyzer gaps into hard
errors instead of silent miscodes.

## Scripts

```
pnpm --filter @snowluma/proton build     # bundle src/index.ts → dist/index.js
pnpm --filter @snowluma/proton test      # vitest run (95 tests)
pnpm --filter @snowluma/proton typecheck # tsc --noEmit
```

## Layout

```
src/
  ast/            analyzer + type-tracking pipeline
    analyzer.ts          single-walk message + call-site collection
    collector.ts         interface → ProtobufField/GenericFieldTemplate
    monomorphizer.ts     generic instantiation → concrete ProtobufMessage
    import-resolver.ts   cross-file definition + wrapper resolution
    callsite.ts          matches protobuf_encode/decode invocations
    static-wrapper.ts    static-method wrapper detection (AST)
    utils.ts             name resolution + synthetic-SF tracking
    dependency-graph.ts  topo sort + reachability
    types.ts             shared schema types
  codegen/        inlined wire-format emitters
    subclass-override.ts per-subclass override codegen
  typecheck/      TypeChecker-backed pipeline (per-subclass overrides)
    program-cache.ts     lazy ts.Program, keyed by tsconfig
    subclass-wrapper.ts  extends-chain walking + type-param resolution
    file-pipeline.ts     per-file glue used by the plugin's transform()
  transform/      Vite plugin string edits
  index.ts        plugin entry (./vite)
  runtime.ts      runtime stubs (.)

protobuf.d.ts     public types (pb<>, pb_repeated<>, primitive aliases)
test/             vitest suite (analyzer + cross-file + plugin + subclass-wrapper)
```
