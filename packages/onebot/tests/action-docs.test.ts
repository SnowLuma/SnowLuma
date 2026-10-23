// Tests the self-generated docs (D4): the describe()-walker aggregates every
// declarative action and renders coherent metadata/markdown.
import { describe, it, expect } from 'vitest';
import { collectActionDocs, renderActionDocsMarkdown } from '../src/action-docs';
import { ACTION_REGISTRY } from '../src/actions';
import { defineAction, defineStreamAction } from '../src/action-kit';
import { okResponse } from '../src/types';

describe('action-docs', () => {
    const docs = collectActionDocs();

    it('covers the migrated declarative actions with unique names', () => {
        expect(docs.length).toBeGreaterThanOrEqual(120);
        const names = docs.map((d) => d.name);
        expect(new Set(names).size).toBe(names.length); // no duplicates
    });

    it('surfaces preset-injected fields + defaults (set_group_ban)', () => {
        const ban = docs.find((d) => d.name === 'set_group_ban');
        expect(ban).toBeDefined();
        expect(ban!.params.map((p) => p.name)).toEqual(['group_id', 'user_id', 'duration']);
        const groupId = ban!.params.find((p) => p.name === 'group_id')!;
        expect(groupId).toMatchObject({ type: 'uint', required: true });
        const duration = ban!.params.find((p) => p.name === 'duration')!;
        expect(duration).toMatchObject({ type: 'int', required: false, default: 1800 });
    });

    it.each(['get_group_root_files', 'get_group_files_by_folder'])(
        'documents folder last-upload metadata for %s',
        (name) => {
            const action = docs.find((d) => d.name === name);
            const properties = action?.returnsSchema?.properties as Record<string, any> | undefined;
            const folderProperties = properties?.folders?.items?.properties as
                Record<string, unknown> | undefined;

            expect(folderProperties).toEqual(
                expect.objectContaining({
                    last_upload_time: expect.objectContaining({ type: 'integer' }),
                    last_uploader: expect.objectContaining({ type: 'integer' }),
                    last_uploader_name: expect.objectContaining({ type: 'string' }),
                }),
            );
        },
    );

    it.each(['get_group_album_list', 'get_qun_album_list'])(
        'documents album cover and last-upload metadata for %s',
        (name) => {
            const action = docs.find((d) => d.name === name);
            const rootProperties = action?.returnsSchema?.properties as
                Record<string, any> | undefined;
            const itemProperties =
                name === 'get_group_album_list'
                    ? (action?.returnsSchema?.items as any)?.properties
                    : rootProperties?.album_list?.items?.properties;

            expect(itemProperties).toEqual(
                expect.objectContaining({
                    last_upload_time: expect.objectContaining({
                        type: name === 'get_group_album_list' ? 'integer' : 'string',
                    }),
                    cover: expect.objectContaining({ type: ['object', 'null'] }),
                }),
            );
            expect(itemProperties.cover.properties.image.properties).toEqual(
                expect.objectContaining({
                    photoUrls: expect.objectContaining({ type: 'array' }),
                    defaultUrl: expect.objectContaining({ type: ['object', 'null'] }),
                    isGif: expect.objectContaining({ type: 'boolean' }),
                    hasRaw: expect.objectContaining({ type: 'boolean' }),
                }),
            );
        },
    );

    it('renders markdown with header + an action section', () => {
        const md = renderActionDocsMarkdown(docs);
        expect(md).toContain('# OneBot Actions');
        expect(md).toContain('`set_group_ban`');
        expect(md).toContain('| 参数 | 类型 | 必填 | 默认 | 说明 |');
        expect(md).toContain('"action": "set_group_ban"');
        expect(md).toContain('"duration": 600');
    });

    it.each(ACTION_REGISTRY.actions)(
        '$canonical examples pass the real parameter parser',
        ({ spec, doc }) => {
            expect(doc.returnsSchema).toBeTypeOf('object');
            expect(doc.examples?.length).toBeGreaterThan(0);

            // Both built-in spec kinds expose a pure parser; do not call handlers
            // here, since examples include writes and process-lifecycle actions.
            if (!('parse' in spec) || typeof spec.parse !== 'function') {
                throw new Error(`${doc.name} has no pure parameter parser`);
            }

            for (const example of doc.examples ?? []) {
                expect(example.summary).not.toBe('');
                const keys = new Set(doc.params.map((param) => param.name));

                for (const key of Object.keys(example.params)) {
                    expect(keys.has(key), `${doc.name} unknown example param ${key}`).toBe(true);
                }

                expect(spec.parse(example.params), `${doc.name}: ${example.summary}`).toMatchObject(
                    { ok: true },
                );
            }
        },
    );

    it('keeps documentation metadata optional for existing custom specs', () => {
        for (const define of [defineAction, defineStreamAction]) {
            const spec = define({ name: 'custom', params: {}, run: () => okResponse() });
            expect(spec.describe().examples).toBeUndefined();
            expect(spec.describe().returnsSchema).toBeUndefined();
            expect(spec.parse({})).toMatchObject({ ok: true });
        }
    });

    it('isolates collected examples and schemas from caller mutations', () => {
        const copy = collectActionDocs();
        const action = copy.find((doc) => doc.name === 'send_group_msg')!;
        action.examples![0].params.group_id = 99999;
        action.returnsSchema!.type = 'null';
        const fresh = collectActionDocs().find((doc) => doc.name === action.name)!;
        expect(fresh.examples![0].params.group_id).toBe(20001);
        expect(fresh.returnsSchema!.type).toBe('object');
    });

    it('documents custom reply content on every forward entry point', () => {
        for (const name of [
            'upload_forward_msg',
            'upload_foward_msg',
            'send_forward_msg',
            'send_group_forward_msg',
            'send_private_forward_msg',
        ]) {
            const action = docs.find((doc) => doc.name === name)!;

            for (const field of ['messages', 'message']) {
                expect(action.params.find((param) => param.name === field)?.desc).toContain(
                    'reply.data.message',
                );
            }
        }

        expect(docs.find((doc) => doc.name === 'get_forward_msg')?.returns).toContain(
            'qq/time/seq',
        );
    });
});
