import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

// Browser-safe workspace packages are consumed from TypeScript source (no Node built-ins reach the bundle).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@kiu/vcard/dist/qr-format', replacement: src('vcard/src/qr-format.ts') },
      { find: '@kiu/shared', replacement: src('shared/src/index.ts') },
      { find: '@kiu/offline-core', replacement: src('offline-core/src/index.ts') },
      { find: '@kiu/ui/tokens.css', replacement: src('ui/src/tokens.css') },
      { find: '@kiu/ui', replacement: src('ui/src/index.ts') },
    ],
  },
  test: { environment: 'node' },
});
