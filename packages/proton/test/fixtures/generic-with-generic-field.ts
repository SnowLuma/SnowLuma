// Generic template with a generic-instantiated message field.
//
// The outer template's type param (`U`) shows up *inside* an inner generic
// instantiation (`Wrapper<U>`). When the outer is monomorphized at the call
// site (`Outer<uint_32>`), the inner instantiation must be re-instantiated
// with the substitution (becoming `Wrapper<uint_32>`) and put into the
// registry under its mangled name `Wrapper__uint_32`.
//
// Without the fix, the field's `rawTypeName` was `'Wrapper__U'` and the
// substituted-mono never produced `Wrapper__uint_32`, leaving the field's
// wire-type unresolved.

interface Wrapper<T> {
    value: pb<1, T>;
}

interface Outer<U> {
    wrapped: pb<5, Wrapper<U>>;
}

const data = protobuf_encode<Outer<uint_32>>({ wrapped: { value: 42 } });
const decoded = protobuf_decode<Outer<uint_32>>(data);

export { };
