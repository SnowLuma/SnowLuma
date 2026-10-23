import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const style = `
:root{color-scheme:light dark;font-family:system-ui,sans-serif;color:var(--color-text-primary,#20242d);background:var(--color-background-primary,#fff)}
*{box-sizing:border-box}body{margin:0;padding:24px;max-width:760px}h1{font-size:21px;margin:0 0 18px}#target{font-size:14px;font-weight:650;margin:0 0 14px}#message{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6;margin:0;padding:18px;border:1px solid var(--color-border-primary,#d7dce3);border-radius:10px}#reply{font-size:13px;margin:12px 0;color:var(--color-text-secondary,#626b78)}#status{font-size:14px;line-height:1.5;margin:18px 0}footer{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;font-size:14px;border:1px solid var(--color-border-primary,#bbc4d0);border-radius:8px;padding:10px 16px;cursor:pointer;background:var(--color-background-primary,#fff);color:inherit}#send{background:#2252a5;color:white;border-color:#2252a5}button:disabled{opacity:.55;cursor:default}button:focus-visible{outline:3px solid #8eb7ff;outline-offset:3px}@media(prefers-color-scheme:dark){:root{color:var(--color-text-primary,#e8ecf3);background:var(--color-background-primary,#1b1e24)}#reply{color:var(--color-text-secondary,#b3bdcb)}button{background:var(--color-background-primary,#1b1e24)}}
`.trim();

export async function buildMessageApp(outDir = join(packageRoot, 'dist')) {
  const result = await build({
    configFile: false,
    root: packageRoot,
    logLevel: 'error',
    build: {
      write: false,
      sourcemap: false,
      lib: {
        entry: join(packageRoot, 'apps/message-preview.ts'),
        name: 'SnowLumaMessagePreview',
        formats: ['iife'],
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;

  if (outputs.length !== 1 || outputs[0].type !== 'chunk') {
    throw new Error('Message app must build to a single self-contained script');
  }

  const script = outputs[0].code.replace(/<\/script/gi, '<\\/script');
  const hash = (source) => createHash('sha256').update(source).digest('base64');
  const csp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>消息草稿预览</title><style>${style}</style></head>
<body><main><h1>消息草稿预览</h1><p id="target">正在载入草稿…</p><pre id="message"></pre><p id="reply"></p><p id="status" role="status" aria-live="polite">消息尚未发送。</p><footer><button id="send" type="button" disabled>发送这条消息</button><button id="cancel" type="button" disabled>取消草稿</button></footer></main><script>${script}</script></body></html>`;
  const filename = join(outDir, 'message-app.html');
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, html, 'utf8');
  return filename;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMessageApp();
}
