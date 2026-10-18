import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRuntimeConfig, updateRuntimeConfig } from '@snowluma/common/runtime';
import { createUpdateService } from '../src/update/service';
import { updateRoutes } from '../src/webui/update-routes';

let directory: string;
let previous: string;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-update-sources-'));
    previous = process.cwd();
    process.chdir(directory);
});
afterEach(() => {
    process.chdir(previous);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(directory, { recursive: true, force: true });
});

async function routes() {
    return updateRoutes(await createUpdateService(undefined, '2.0.1'), vi.fn());
}

describe('update source routes', () => {
    it('returns a JSON error when persisted source settings are invalid', async () => {
        fs.mkdirSync('config');
        fs.writeFileSync(
            'config/runtime.json',
            JSON.stringify({ updateSource: { mode: 'invalid' } }),
        );
        const response = await (await routes()).request('/sources');
        expect(response.status).toBe(500);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await response.json()).toMatchObject({
            message: expect.stringContaining('模式无效'),
        });
    });
    it('persists settings for subsequent reads without changing other runtime values', async () => {
        updateRuntimeConfig({ webuiPort: 6789, webuiHost: '127.0.0.2' });
        const app = await routes();
        const config = {
            mode: 'mirror',
            mirror: 'https://example.com/proxy/',
            mirrors: ['https://second.example/'],
        };
        const response = await app.request('/sources', {
            method: 'POST',
            body: JSON.stringify(config),
        });
        expect(response.status).toBe(200);
        const normalized = {
            ...config,
            mirror: 'https://example.com/proxy',
            mirrors: ['https://second.example'],
        };
        expect(await response.json()).toMatchObject({
            config: normalized,
            saved: true,
            applied: true,
            errors: [],
        });
        expect(readRuntimeConfig()).toMatchObject({
            updateSource: normalized,
            webuiPort: 6789,
            webuiHost: '127.0.0.2',
        });
        expect(await (await app.request('/sources')).json()).toEqual({ config: normalized });
    });

    it.each(['not json', '{}', '[]', '{"mode":"mirror","mirrors":[]}'])(
        'rejects malformed input without saving or fetching: %s',
        async (body) => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const app = await routes();

            for (const endpoint of ['/sources', '/sources/test']) {
                expect((await app.request(endpoint, { method: 'POST', body })).status).toBe(400);
            }

            expect(fetchMock).not.toHaveBeenCalled();
            expect(fs.existsSync('config/runtime.json')).toBe(false);
        },
    );

    it('reports a persistence failure without claiming the config was saved', async () => {
        updateRuntimeConfig({ webuiPort: 6789 });
        const before = fs.readFileSync('config/runtime.json', 'utf8');
        vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
            throw new Error('disk replacement failed');
        });
        const response = await (
            await routes()
        ).request('/sources', {
            method: 'POST',
            body: JSON.stringify({ mode: 'direct', mirror: '', mirrors: [] }),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ message: 'disk replacement failed' });
        expect(fs.readFileSync('config/runtime.json', 'utf8')).toBe(before);
    });
});
