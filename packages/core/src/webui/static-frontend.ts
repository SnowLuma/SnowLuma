import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Hono, Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { injectWebuiTarget, type WebuiTarget } from '@snowluma/common/webui-target';

/** All document entry paths share runtime injection, including direct index.html requests. */
export function registerStaticFrontend(app: Hono, root: string, target: WebuiTarget | null): void {
    const indexPath = path.join(root, 'index.html');

    const document = (c: Context) => {
        if (!existsSync(indexPath)) {
            return c.text(
                'WebUI client bundle not found. Run `pnpm --filter webui build` (or use the dev server on :5178).',
                404,
            );
        }

        // A packaged frontend can be reused with a different deployment target on restart.
        c.header('Cache-Control', 'no-store');
        return c.html(injectWebuiTarget(readFileSync(indexPath, 'utf8'), target));
    };

    app.get('/', document);
    app.get('/index.html', document);
    app.use('/*', serveStatic({ root }));
    app.get('*', (c) => {
        if (['/api/', '/avatar/', '/ui-asset/'].some((prefix) => c.req.path.startsWith(prefix))) {
            return c.text('not found', 404);
        }

        return document(c);
    });
}
