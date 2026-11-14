import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 4,
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
