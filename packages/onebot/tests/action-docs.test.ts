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

  it('renders markdown with header + an action section', () => {
    const md = renderActionDocsMarkdown(docs);
    expect(md).toContain('# OneBot Actions');
    expect(md).toContain('`set_group_ban`');
    expect(md).toContain('| 参数 | 类型 | 必填 | 默认 | 说明 |');
  });
});
