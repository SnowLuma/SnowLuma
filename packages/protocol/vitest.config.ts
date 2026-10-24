// Vitest config — drives both `pnpm bench` and `pnpm test`.
// Tests live under `tests/`, benchmarks under `bench/`.
import protobufVitePlugin from '@snowluma/proton/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    // proton's vite plugin inlines `protobuf_encode<T>` / `protobuf_decode<T>`
    // call sites at build time. Required for both tests and benchmarks
    // to exercise the production codecs. Untransformed calls throw at runtime.
    plugins: [protobufVitePlugin()],
    test: {
        include: ['tests/**/*.test.ts'],
        benchmark: {
            include: ['bench/**/*.bench.ts'],
        },
        environment: 'node',
    },
});
