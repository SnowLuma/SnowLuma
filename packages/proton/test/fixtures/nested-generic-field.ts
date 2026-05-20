// Concrete interface with a generic-instantiated message field.
//
// The call site only references the concrete outer type (`Container`), so
// the analyzer must independently:
//   1) resolve the field's typeName to the *mangled* form (`Wrapper__uint_32`)
//      so it matches what monomorphization produces,
//   2) enqueue `Wrapper<uint_32>` for monomorphization itself, since the
//      call-site-driven queue only sees `Container`.
//
// Without both, wire-type resolution silently leaves the field at the
// `WireType.Varint` placeholder and codegen emits a wrong wire format.

interface Wrapper<T> {
    value: pb<1, T>;
}

interface Container {
    wrapped: pb<5, Wrapper<uint_32>>;
}

const data = protobuf_encode<Container>({ wrapped: { value: 42 } });
const decoded = protobuf_decode<Container>(data);

export { };
