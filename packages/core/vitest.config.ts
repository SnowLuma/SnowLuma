import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
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
    // ring buffer / subscribers, which sit behind the console-level gate.
    env: {
      SNOWLUMA_LOG_FILE: '0',
      SNOWLUMA_LOG_LEVEL: 'debug'
    }
  }
});
