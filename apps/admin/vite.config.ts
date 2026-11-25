import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@kiu/shared', replacement: src('shared/src/index.ts') },
      { find: '@kiu/ui/tokens.css', replacement: src('ui/src/tokens.css') },
      { find: '@kiu/ui', replacement: src('ui/src/index.ts') },
    ],
  },
  test: { environment: 'node' },
});
