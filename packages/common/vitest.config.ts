// Vitest config for @snowluma/common. Pure-TS package (no proton), so a
// plain node-environment runner over tests/ is enough.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
