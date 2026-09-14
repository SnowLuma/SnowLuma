// Tests the self-generated docs (D4): the describe()-walker aggregates every
// declarative action and renders coherent metadata/markdown.
import { describe, it, expect } from 'vitest';
import { collectActionDocs, renderActionDocsMarkdown } from '../src/action-docs';

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
      const folderProperties = properties?.folders?.items?.properties as Record<string, unknown> | undefined;

      expect(folderProperties).toEqual(expect.objectContaining({
        last_upload_time: expect.objectContaining({ type: 'integer' }),
        last_uploader: expect.objectContaining({ type: 'integer' }),
        last_uploader_name: expect.objectContaining({ type: 'string' }),
      }));
    },
  );

  it.each(['get_group_album_list', 'get_qun_album_list'])(
    'documents album cover and last-upload metadata for %s',
    (name) => {
      const action = docs.find((d) => d.name === name);
      const rootProperties = action?.returnsSchema?.properties as Record<string, any> | undefined;
      const itemProperties = name === 'get_group_album_list'
        ? (action?.returnsSchema?.items as any)?.properties
        : rootProperties?.album_list?.items?.properties;

      expect(itemProperties).toEqual(expect.objectContaining({
        last_upload_time: expect.objectContaining({
          type: name === 'get_group_album_list' ? 'integer' : 'string',
        }),
        cover: expect.objectContaining({ type: ['object', 'null'] }),
      }));
      expect(itemProperties.cover.properties.image.properties).toEqual(expect.objectContaining({
        photoUrls: expect.objectContaining({ type: 'array' }),
        defaultUrl: expect.objectContaining({ type: ['object', 'null'] }),
        isGif: expect.objectContaining({ type: 'boolean' }),
        hasRaw: expect.objectContaining({ type: 'boolean' }),
      }));
    },
  );

  it('renders markdown with header + an action section', () => {
    const md = renderActionDocsMarkdown(docs);
    expect(md).toContain('# OneBot Actions');
    expect(md).toContain('`set_group_ban`');
    expect(md).toContain('| 参数 | 类型 | 必填 | 默认 | 说明 |');
  });
});
