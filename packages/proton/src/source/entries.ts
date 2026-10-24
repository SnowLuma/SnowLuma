import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedConfig } from 'vite';

export function buildEntries(config: ResolvedConfig): string[] {
    const input =
        config.build.rolldownOptions.input ??
        (config.build.lib && config.build.lib.entry) ??
        'index.html';
    const files =
        typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
    return files.flatMap((file) => {
        const path = resolve(config.root, file);

        if (!existsSync(path)) {
            return [];
        }

        if (/\.[cm]?[jt]sx?$/.test(path)) {
            return [path];
        }

        if (!path.endsWith('.html')) {
            return [];
        }

        return [
            ...readFileSync(path, 'utf8').matchAll(
                /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
            ),
        ].flatMap(([, src]) => {
            if (/^(?:[a-z]+:)?\/\//i.test(src)) {
                return [];
            }

            const entry = resolve(
                src.startsWith('/') ? config.root : resolve(path, '..'),
                src.replace(/^\//, '').split('?')[0],
            );
            return /\.[cm]?[jt]sx?$/.test(entry) && existsSync(entry) ? [entry] : [];
        });
    });
}
