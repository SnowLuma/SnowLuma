import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist');
const entryPoint = path.join(root, 'index.mjs');

if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`release directory does not exist: ${root}`);
}
if (!fs.statSync(entryPoint, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`release entry point must be at the archive root: ${entryPoint}`);
}

const forbidden = [];
const pending = [root];
while (pending.length > 0) {
  const directory = pending.pop();
  if (!directory) continue;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(directory, entry.name);
    if (/snowluma/i.test(entry.name)) {
      forbidden.push(path.relative(root, absolute));
    }
    pending.push(absolute);
  }
}

if (forbidden.length > 0) {
  throw new Error(`release contains forbidden directory names:\n${forbidden.join('\n')}`);
}

console.log(`Release layout verified: ${root}`);
