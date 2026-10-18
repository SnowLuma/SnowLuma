import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReleaseManifest } from '../../src/update/files';

export async function releaseFixture(
    root: string,
    version: string,
    target = 'win32-x64',
    chunk = 'chunk.mjs',
): Promise<ReleaseManifest> {
    const entries = [
        'index.mjs',
        'app.mjs',
        chunk,
        'native',
        'client',
        'package.json',
        'release.json',
        'EULA.md',
        'PRIVACY.md',
        'check-node-version.cjs',
        target.startsWith('win32') ? 'launcher.bat' : 'launcher.sh',
    ];
    const manifest = { version, target, entries };
    await mkdir(path.join(root, 'native'), { recursive: true });
    await mkdir(path.join(root, 'client'), { recursive: true });

    for (const file of entries.filter((entry) => !['native', 'client'].includes(entry))) {
        await writeFile(path.join(root, file), version);
    }

    await writeFile(path.join(root, 'native', 'binding.node'), version);
    await writeFile(path.join(root, 'client', 'index.html'), version);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
    await writeFile(path.join(root, 'release.json'), JSON.stringify(manifest));
    return manifest;
}
