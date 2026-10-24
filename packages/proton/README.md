# @snowluma/proton

Compile-time protobuf codecs for SnowLuma. TypeScript schemas and generic calls
are compiled into specialized encoders and decoders without runtime schema lookup.

Vendored from [SnowLuma/protobuf-dsl](https://github.com/SnowLuma/protobuf-dsl)
(`protobuf-fastdsl`, commit `22e382a`), whose README declares the MIT license.
SnowLuma retains the `@snowluma/proton` package name, manifest and wire compatibility
rules described below.

## Setup

Add `@snowluma/proton: workspace:*` to the consuming package's dependencies and
enable the plugin in its Vite or Vitest configuration:

```ts
import { defineConfig } from 'vite';
import protobufVitePlugin from '@snowluma/proton/vite';

export default defineConfig({
    plugins: [protobufVitePlugin()],
});
```

The plugin entry resolves to a built artifact. After editing the compiler, run
`pnpm --filter @snowluma/proton build` before testing consuming packages.
Calls without the plugin throw a diagnostic naming `@snowluma/proton/vite`.

```ts
import type { pb, pb_optional, pb_repeated, uint_32 } from '@snowluma/proton';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

interface Profile {
    id?: pb<1, uint_32>;
    name?: pb<2, string>;
    tags?: pb_repeated<3, string>;
    state?: pb_optional<4, uint_32>;
}

const bytes = protobuf_encode<Profile>({ id: 42, name: 'alice', state: 0 });
const profile = protobuf_decode<Profile>(bytes);
```

## Schema and compiler support

`pb<N, T>` marks a singular field, `pb_repeated<N, T>` marks a repeated field,
and `pb_optional<N, T>` gives a singular field explicit wire presence.

| Types | TypeScript value | Wire format |
| --- | --- | --- |
| `uint_32`, `int_32`, `sint_32` | `number` | Varint; `sint_32` uses zigzag |
| `uint_64`, `int_64`, `sint_64` | `bigint` | Varint; `sint_64` uses zigzag |
| `bool` | `boolean` | Varint |
| `fixed_32`, `sfixed_32`, `float` | `number` | 32-bit |
| `fixed_64`, `sfixed_64` | `bigint` | 64-bit |
| `double` | `number` | 64-bit |
| `string`, `bytes` | `string`, `Uint8Array` | Length-delimited |
| Message interfaces | Object | Length-delimited |

The compiler resolves aliases, namespace imports, `export *`, relative and bare
package imports, nested generic schemas, generic functions and classes, and
forwarded callbacks. It preserves wrapper bodies and passes generated codecs
through generic calls. It also supports resolvable mapped, conditional and utility
types; ambiguous unions and unresolved schemas fail during compilation.

Only required codecs and helpers are emitted. Nested message encoders measure and
write into a shared output buffer. Returned bytes may be a view into a larger
buffer; use `byteOffset` and `byteLength`, or `bytes.slice()` when an independent
backing buffer is needed. Later encodes do not overwrite previously returned bytes.

## SnowLuma wire compatibility

- Plain `pb<>` scalars omit default values (`0`, `0n`, `false`, empty strings and
  empty bytes), including fields marked with TypeScript `?`. Missing optional
  singular fields decode to `null`.
- `pb_optional<>` emits present default values while omitting `null`/`undefined`.
  This preserves the explicit `state=0` needed to disable whole-group mute.
- Negative `int_32` values retain SnowLuma's five-byte outbound encoding. Decoders
  accept both that form and canonical ten-byte sign-extended values.
- `uint_32` values consume a complete valid varint of up to ten bytes and retain
  the low 32 bits. Tags and lengths remain limited to valid 32-bit framing.
- Decoders reject truncated/overflowing fields, invalid bounds and malformed
  groups. Unknown groups are skipped within their parent frame with bounded depth.
- Unknown tags retain non-enumerable metadata, available through
  `protobuf_getUnknownFields` and `protobuf_getUnknownFieldMetadata`. Metadata
  aggregates occurrences, retains at most 64 field/wire kinds per message, and
  summarizes omitted kinds without retaining their payloads.

The previous runtime-map fallback and plugin option have been removed. Consumers
must compile encode/decode calls with the plugin.

## Migration audit

The upstream implementation was checked against Proton's source history before
replacement. The following behavior is covered by regression tests:

| Proton history | Upstream status / retained behavior |
| --- | --- |
| Initial vendor fixes (`194165f4`) and generic OIDB migration (`58028123`) | Aliased markers, nested generic fields and forwarded wrappers are covered by the new compiler and integration tests. |
| Barrel exports (`f21740a5`) and bare imports (`994633ea`) | Supported by the new source resolver; tested through bundled cross-file and package fixtures. |
| Explicit presence (`90f26ca4`) | Added `pb_optional` to the new schema pipeline and kept `?` separate from wire presence. |
| Decoder hardening (`b7d648ea`) | Upstream already checks varints and field boundaries; retained integer bounds, group handling, bounded unknown metadata and legacy outbound `int32` bytes. |
| Extended `uint32` (`b53004ee`, `613b2b1e`) | Upstream consumes full value varints; retained the existing QQ regression fixtures. |
| Cleanup (`c7428363`) | Superseded by the new compiler/source module structure. |

## Validation and layout

From the repository root:

```sh
pnpm --filter @snowluma/proton build
pnpm --filter @snowluma/proton typecheck
pnpm --filter @snowluma/proton test
```

`test/upstream` contains the imported compiler, codegen and plugin suite, adjusted
for SnowLuma's package layout and wire rules. `test/__tests__` retains Proton's
wire regression tests and adds migration compatibility cases. Consumer tests in
`packages/protocol/tests` exercise real QQ schemas with the built plugin.

```text
src/
  source/      source files, TypeScript module resolution and build entries
  schema/      type resolution and message construction
  compiler/    call analysis, generic codec propagation and source rewriting
  codegen/     wire emitters and selected helper generation
  index.ts     Vite plugin
  package.ts   package identity from package.json
  runtime.ts   uncompiled-call errors and unknown-field diagnostics
protobuf.d.ts  public field markers and runtime declarations
```
