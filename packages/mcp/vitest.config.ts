// Vitest config — used only to RUN the catalog generator (scripts/gen-catalog.test.ts)
// in an environment where `@snowluma/onebot/action-docs` resolves. The proton
// plugin provides the same bare-specifier resolver @snowluma/onebot's own tests
// use, so importing the action specs works identically here.
import protobufVitePlugin from '@snowluma/proton/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [protobufVitePlugin()],
  test: {
    include: ['scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    env: {
      SNOWLUMA_LOG_FILE: '0',
    },
  },
});
