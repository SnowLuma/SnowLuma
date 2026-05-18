import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/__tests__/**/*.test.ts'],
  },
});
