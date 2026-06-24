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
  },
});
