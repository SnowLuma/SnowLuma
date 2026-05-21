// Vitest config — only used by `pnpm bench` to drive the perf
// micro-benchmarks under `bench/`. There are no `*.test.ts` files in
// this package (bridge tests live in @snowluma/core's test suite by
// historical accident); if/when they migrate over, point
// `test.include` at them here.
import protobufVitePlugin from '@snowluma/proton/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // proton's vite plugin inlines `protobuf_encode<T>` / `protobuf_decode<T>`
  // call sites at build time. Required for tinybench-driven benches to
  // hit the production code path rather than proton's runtime-fallback
  // (which throws unless a runtime-map JSON is loaded).
  plugins: [protobufVitePlugin()],
  test: {
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    environment: 'node',
  },
});
