import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [tailwindcss(), react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
    server: {
        port: 5178,
        strictPort: false,
        proxy: {
            '/api': { target: 'http://localhost:5099', changeOrigin: true, ws: true },
            '/avatar': { target: 'http://localhost:5099', changeOrigin: true },
        },
    },
    build: {
        // Emit into the monorepo-root dist/client so the bundled core can serve it via Hono.
        outDir: '../../dist/client',
        emptyOutDir: true,
    },
});
