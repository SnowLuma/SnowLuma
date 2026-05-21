// Globals injected by Vite at build time (see `packages/core/vite.config.ts`).
// `__APP_VERSION__` reads from the monorepo root `package.json::version`;
// `__BUILD_WEBUI__` flips on when `BUILD_WEBUI=true` is set so the runner
// stitches the SPA assets in. Both are typed as `unknown` outside vite
// (e.g. when running tests via vitest where the plugin isn't applied) —
// callers guard with `typeof __APP_VERSION__ !== 'undefined'`.
declare const __BUILD_WEBUI__: boolean;
declare const __APP_VERSION__: string;
