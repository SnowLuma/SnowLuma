import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerStaticFrontend } from '../src/webui/static-frontend';

let root: string;
const html = '<!doctype html><html><head><title>SnowLuma</title></head><body>app</body></html>';

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'snowluma-presentation-'));
    writeFileSync(path.join(root, 'index.html'), html);
    writeFileSync(path.join(root, 'asset.js'), 'window.asset = true;');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runtime target document delivery', () => {
    it.each(['/', '/index.html', '/settings?tab=appearance'])(
        'injects on %s before authentication',
        async (url) => {
            const app = new Hono();
            registerStaticFrontend(app, root, 'maibot');
            const response = await app.request(url);
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(await response.text()).toContain('"target":"maibot"');
        },
    );

    it('reuses the exact same built frontend for an unconfigured deployment', async () => {
        const app = new Hono();
        registerStaticFrontend(app, root, null);
        expect(await (await app.request('/index.html')).text()).toBe(html);
    });

    it('does not inject into assets or API error responses', async () => {
        const app = new Hono();
        registerStaticFrontend(app, root, 'maibot');
        expect(await (await app.request('/asset.js')).text()).toBe('window.asset = true;');

        for (const url of ['/api/missing', '/avatar/missing', '/ui-asset/missing']) {
            expect((await app.request(url)).status).toBe(404);
        }
    });

    it('does not serve a protected static path through a second percent decode', async () => {
        mkdirSync(path.join(root, 'admin'));
        writeFileSync(path.join(root, 'admin', 'private.txt'), 'protected fixture');
        const app = new Hono();
        app.use('/admin/*', async (c) => c.text('unauthorized', 401));
        registerStaticFrontend(app, root, null);

        for (const url of ['/admin/private.txt', '/%61dmin/private.txt']) {
            const response = await app.request(url);
            expect(response.status).toBe(401);
            expect(await response.text()).toBe('unauthorized');
        }

        // The router sees /%61dmin; decoding again would reach /admin
        // after the middleware for that prefix has already been skipped.
        const response = await app.request('/%%36%31dmin/private.txt');
        expect(await response.text()).toBe(html);
    });

    it.each(['hello world.js', '图标.js'])(
        'still serves ordinarily encoded asset names: %s',
        async (filename) => {
            writeFileSync(path.join(root, filename), 'window.encodedAsset = true;');
            const app = new Hono();
            registerStaticFrontend(app, root, null);
            const response = await app.request(`/${encodeURIComponent(filename)}`);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('window.encodedAsset = true;');
        },
    );
});
