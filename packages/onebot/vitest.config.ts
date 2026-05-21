// Vitest config — runs the OneBot tests against the workspace TS
// source directly (no build step). The 20 tests here were previously
// inside `packages/core/tests/` and ran via `@snowluma/core`'s vitest
// invocation; they moved over wholesale in the Phase 3 split.
import protobufVitePlugin from '@snowluma/proton/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@snowluma/proton` provides the bare-specifier resolver that turns
  // `import type { OidbBase } from '@snowluma/proto-defs/oidb'` into
  // a zero-runtime encoder/decoder at the call site. The same plugin
  // is loaded by `@snowluma/core`'s vite config — keep it here so the
  // OneBot tests resolve identically.
  plugins: [protobufVitePlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Suppress the logger's file transport during tests so the suite
    // doesn't litter cwd with logs/snowluma-*.log files. Tests that
    // explicitly cover file output set their own SNOWLUMA_LOG_FILE='1'
    // + SNOWLUMA_LOG_DIR=<tmp>.
    //
    // Run at debug level so tests asserting on debug-level log entries
    // (e.g. action dispatch entry lines) actually see them via the
    // ring buffer / subscribers, which sit behind the console-level
    // gate. Mirrors the equivalent env setup in @snowluma/core's
    // vitest.config.ts.
    env: {
      SNOWLUMA_LOG_FILE: '0',
      SNOWLUMA_LOG_LEVEL: 'debug'
    }
  },
});
