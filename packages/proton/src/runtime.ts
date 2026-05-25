/**
 * Runtime stubs.
 *
 * `protobuf_encode<T>()` / `protobuf_decode<T>()` are placeholders that
 * exist only so the user's source type-checks and bundlers don't strip
 * the import. Every real call site is rewritten by the proton Vite
 * plugin (`@snowluma/proton/vite`) into a fully-inlined, type-specific
 * codec call. If the plugin isn't installed, hitting these stubs at
 * runtime is a bug — we throw loudly rather than silently producing
 * wrong bytes.
 */
export function protobuf_encode<T>(_params: T): Uint8Array {
  throw new Error(
    'protobuf_encode<T>() was not transformed by the @snowluma/proton Vite plugin. ' +
    'Make sure protobufVitePlugin() is added to your vite.config.ts plugins array.',
  );
}

export function protobuf_decode<T>(_data: Uint8Array): T {
  throw new Error(
    'protobuf_decode<T>() was not transformed by the @snowluma/proton Vite plugin. ' +
    'Make sure protobufVitePlugin() is added to your vite.config.ts plugins array.',
  );
}
