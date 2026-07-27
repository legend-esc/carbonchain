import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    // app.spec.ts uses external templateUrl/styleUrl which require the Angular
    // build toolchain (ng test). All other specs run fine under vitest.
    exclude: ['**/node_modules/**', 'src/app/app.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // #562 — CreditStore holds optimistic-update/rollback logic that must stay
      // well-tested; fail CI if coverage on this file drops below 90%.
      thresholds: {
        'src/app/core/store/credit.store.ts': {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
