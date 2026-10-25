import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ParamField } from '../src/components/debug/param-field';
import { buildActionParams } from '../src/lib/action-params';

describe('debug action form parameters', () => {
    const objectParam = { name: 'feed', type: 'object', required: true };

    it('passes pasted objects with nested and unknown fields to the action', () => {
        const feed = { identity: { id: 'opaque' }, future: [1, null, { enabled: true }] };
        expect(buildActionParams([objectParam], { feed: JSON.stringify(feed, null, 2) })).toEqual({
            feed,
        });
    });

    it.each(['{bad', '[]', 'null', '1', 'false', '"text"'])(
        'rejects invalid object input %s with the field name',
        (feed) => {
            expect(() => buildActionParams([objectParam], { feed })).toThrow(/feed/);
        },
    );

    it('omits an untouched optional object rather than sending an empty string', () => {
        expect(buildActionParams([{ ...objectParam, required: false }], { feed: '' })).toEqual({});
    });

    it('renders an object editor that accepts multiline JSON', () => {
        const html = renderToStaticMarkup(
            <ParamField
                param={objectParam}
                value={'{\n  "id": "opaque"\n}'}
                onChange={() => undefined}
                uin=""
                groupContext=""
                actionName="get_qzone_public_feed_detail"
            />,
        );
        expect(html).toContain('<textarea');
        expect(html).toContain('aria-label="feed"');
    });

    const contentParam = { name: 'content', type: 'string | object[]', required: true };

    it.each(['[]', '[1,2]', '[{"type":0,"content":"hello"}]', ' \n中文 '])(
        'preserves JSON-looking text %j when entered as a JSON string',
        (content) => {
            expect(buildActionParams([contentParam], { content: JSON.stringify(content) })).toEqual(
                { content },
            );
        },
    );

    it('passes a real rich-item array without converting it to OneBot segments', () => {
        const content = [{ type: 0, content: 'hello', future: { keep: true } }];
        expect(buildActionParams([contentParam], { content: JSON.stringify(content) })).toEqual({
            content,
        });
    });

    it.each(['[bad', '[1,2]', 'null', '1', 'false', '{}', '[null]', '[[]]'])(
        'reports invalid rich content %s before invoking an action',
        (content) => {
            expect(() => buildActionParams([contentParam], { content })).toThrow(/content/);
        },
    );

    it('renders rich content as an explicit JSON editor without the OneBot message builder', () => {
        const html = renderToStaticMarkup(
            <ParamField
                param={contentParam}
                value={'"[1,2]"'}
                onChange={() => undefined}
                uin=""
                groupContext=""
                actionName="comment_qzone_public_feed"
            />,
        );
        expect(html).toContain('<textarea');
        expect(html).toContain('aria-label="content"');
        expect(html).toContain('JSON 字符串');
        expect(html).not.toContain('role="radiogroup"');
    });

    it('keeps existing scalar and OneBot message conversions', () => {
        const fields = {
            message_id: '-123',
            enable: 'false',
            message: '[{"type":"text","data":{"text":"hello"}}]',
            text: '[1,2]',
        };
        expect(
            buildActionParams(
                [
                    { name: 'message_id', type: 'messageId', required: true },
                    { name: 'enable', type: 'bool', required: true },
                    { name: 'message', type: 'message', required: true },
                    { name: 'text', type: 'string', required: true },
                ],
                fields,
            ),
        ).toEqual({
            message_id: -123,
            enable: false,
            message: [{ type: 'text', data: { text: 'hello' } }],
            text: '[1,2]',
        });
    });
});
