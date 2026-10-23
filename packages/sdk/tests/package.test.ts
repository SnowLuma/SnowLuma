import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';

const sdkRoot = fileURLToPath(new URL('..', import.meta.url));
const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const manifest = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, string | { import: string; types: string }>;
};
const entrypoints = Object.entries(manifest.exports)
    .filter(([, target]) => typeof target !== 'string')
    .map(([entry]) => `${manifest.name}${entry === '.' ? '' : entry.slice(1)}`);
let consumerRoot: string;

function node(args: string[]): void {
    const result = spawnSync(process.execPath, args, {
        cwd: consumerRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30_000,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            `Node exited with status ${result.status} (signal ${result.signal}):\n${result.stdout}\n${result.stderr}`,
        );
    }
}

beforeAll(() => {
    consumerRoot = mkdtempSync(path.join(tmpdir(), 'snowluma-sdk-package-'));
    const installed = path.join(consumerRoot, 'node_modules', '@snowluma', 'sdk');
    mkdirSync(installed, { recursive: true });
    copyFileSync(path.join(sdkRoot, 'package.json'), path.join(installed, 'package.json'));
    copyFileSync(
        path.join(sdkRoot, 'tests', 'fixtures', 'action-types.mts'),
        path.join(consumerRoot, 'action-types.mts'),
    );
    copyFileSync(
        path.join(sdkRoot, 'tests', 'fixtures', 'action-contracts.ts'),
        path.join(consumerRoot, 'action-contracts.ts'),
    );
    copyFileSync(
        path.join(sdkRoot, 'tests', 'fixtures', 'messaging-types.mts'),
        path.join(consumerRoot, 'messaging-types.mts'),
    );

    // Compile fresh output outside the workspace so neither stale dist files nor
    // Vitest's source resolver can hide a broken published entry point.
    node([
        compiler,
        '--project',
        path.join(sdkRoot, 'tsconfig.json'),
        '--outDir',
        path.join(installed, 'dist'),
    ]);
    writeFileSync(
        path.join(consumerRoot, 'consumer.mts'),
        `import { SnowLumaHttpClient, text, type SnowLumaKnownAction as RootKnownAction } from '@snowluma/sdk';
import { SnowLumaWebSocketClient, type SnowLumaHttpClientOptions } from '@snowluma/sdk/client';
import { MessageChain } from '@snowluma/sdk/messages';
import { isMessageEvent, type EventMiddleware } from '@snowluma/sdk/events';
import { SnowLumaApiError } from '@snowluma/sdk/errors';
import { SNOWLUMA_ACTIONS, isSnowLumaAction, type SnowLumaKnownAction } from '@snowluma/sdk/actions';
import type { ActionParams, StatusInfo } from '@snowluma/sdk/types';

const options: SnowLumaHttpClientOptions = { baseUrl: 'http://127.0.0.1:3000/' };
const client = new SnowLumaHttpClient(options);
const status: Promise<StatusInfo> = client.getStatus();
const message: MessageChain = text('hello').reply(-42);
const params: ActionParams<'send_group_msg'> = { group_id: 123, message: [] };
client.raw('send_group_msg', params);
client.raw('consumer_extension', { custom: true });
client.sendGroupMessage(123, message);
const middleware: EventMiddleware = async (event, context, next) => {
    if (isMessageEvent(event)) await context.reply(text('received'));
    await next();
};
new SnowLumaWebSocketClient().use(middleware);
const action: RootKnownAction = SNOWLUMA_ACTIONS[0];
function known(value: string): SnowLumaKnownAction | null {
    return isSnowLumaAction(value) ? value : null;
}
const error = new SnowLumaApiError({ status: 'failed', retcode: 1, data: null });
export { status, action, known, error };
`,
    );
}, 30_000);

afterAll(() => {
    if (consumerRoot) {
        rmSync(consumerRoot, { recursive: true, force: true });
    }
});

describe('SDK package entry points', () => {
    it.each(entrypoints)('loads %s in native Node without a bundler', (entrypoint) => {
        node(['--input-type=module', '--eval', `await import(${JSON.stringify(entrypoint)});`]);
    });

    it('preserves runtime identities across the root and subpath exports', () => {
        node([
            '--input-type=module',
            '--eval',
            `import assert from 'node:assert/strict';
import * as sdk from '@snowluma/sdk';
import * as client from '@snowluma/sdk/client';
import * as messages from '@snowluma/sdk/messages';
import * as events from '@snowluma/sdk/events';
import * as errors from '@snowluma/sdk/errors';
import * as actions from '@snowluma/sdk/actions';
assert.equal(sdk.SnowLumaHttpClient, client.SnowLumaHttpClient);
assert.equal(sdk.SnowLumaWebSocketClient, client.SnowLumaWebSocketClient);
assert.equal(sdk.MessageChain, messages.MessageChain);
assert.equal(sdk.quoteMessage, messages.quoteMessage);
assert.equal(sdk.isMessageEvent, events.isMessageEvent);
assert.equal(sdk.SnowLumaApiError, errors.SnowLumaApiError);
assert.equal(sdk.SnowLumaMediaSendError, errors.SnowLumaMediaSendError);
assert.equal(sdk.SNOWLUMA_ACTIONS, actions.SNOWLUMA_ACTIONS);
assert.equal(sdk.isSnowLumaAction, actions.isSnowLumaAction);
assert.ok(sdk.text('hello') instanceof messages.MessageChain);
assert.equal(actions.isSnowLumaAction('send_group_msg'), true);
assert.equal(actions.isSnowLumaAction('consumer_extension'), false);
`,
        ]);
    });

    it.each([
        ['NodeNext', 'NodeNext'],
        ['ESNext', 'Bundler'],
    ])(
        'typechecks a consumer using %s / %s',
        (module, resolution) => {
            node([
                compiler,
                '--noEmit',
                '--strict',
                '--target',
                'ES2022',
                '--lib',
                'ES2022,DOM',
                '--module',
                module,
                '--moduleResolution',
                resolution,
                path.join(consumerRoot, 'consumer.mts'),
                path.join(consumerRoot, 'action-types.mts'),
                path.join(consumerRoot, 'messaging-types.mts'),
            ]);
        },
        30_000,
    );
});
