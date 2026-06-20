import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the user-facing app version: monorepo root package.json.
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'),
) as { version: string };

const backendPort = process.env.SNOWLUMA_WEBUI_PORT || '5290';
const backendTarget = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5178,
    strictPort: false,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true, ws: true },
      '/avatar': { target: backendTarget, changeOrigin: true },
    },
  },
  build: {
    // Emit into the monorepo-root dist/client so the bundled core can serve it via Hono.
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
