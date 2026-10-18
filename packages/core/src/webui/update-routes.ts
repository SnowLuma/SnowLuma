import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { UpdateService } from '../update/service';
import { readUpdateSource, saveUpdateSource, testUpdateSources } from '../update/sources';
import {
    normalizeUpdateSourceConfig,
    type UpdateSourceConfig,
} from '@snowluma/common/update-source';

export function updateRoutes(service: UpdateService, restart: () => void) {
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.get('/status', (c) => c.json(service.status()));
    app.get('/sources', (c) => {
        try {
            return c.json({ config: readUpdateSource() });
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    app.post('/sources', async (c) => {
        let config: UpdateSourceConfig;

        try {
            config = normalizeUpdateSourceConfig(await c.req.json());
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
        }

        try {
            saveUpdateSource(config);
            return c.json({
                config,
                saved: true,
                applied: true,
                online: true,
                errors: [],
                message: '更新来源已保存',
            });
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 500);
        }
    });
    app.post('/sources/test', async (c) => {
        try {
            return c.json({ results: await testUpdateSources(await c.req.json()) });
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
        }
    });
    app.post('/download', async (c) => {
        let body: unknown;

        try {
            body = await c.req.json();
        } catch {
            return c.json({ message: '请求必须是 JSON 对象' }, 400);
        }

        if (!body || typeof body !== 'object' || !('version' in body)) {
            return c.json({ message: '缺少更新版本' }, 400);
        }

        try {
            service.start(body.version);
            return c.json(service.status(), 202);
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 409);
        }
    });
    app.post('/restart', (c) => {
        try {
            service.restart();
            c.env.outgoing.once('finish', restart);
            return c.json(service.status(), 202);
        } catch (error) {
            return c.json({ message: error instanceof Error ? error.message : String(error) }, 409);
        }
    });
    return app;
}
