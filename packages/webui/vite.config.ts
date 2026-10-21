import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { injectWebuiTarget, resolveWebuiTarget } from '@snowluma/common/webui-target';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [
        tailwindcss(),
        react(),
        {
            name: 'webui-runtime-target',
            // Production builds are target-neutral. Core injects the deployment at request time.
            apply: 'serve',
            transformIndexHtml: {
                order: 'pre',
                handler: (html) =>
                    injectWebuiTarget(html, resolveWebuiTarget(process.env.SNOWLUMA_WEBUI_TARGET)),
            },
        },
    ],
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
