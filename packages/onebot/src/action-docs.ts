// action-docs — self-generated OneBot API docs (D4).
//
// Walks `ActionSpec.describe()` over every declarative action and renders a
// structured doc list + a Markdown view. The metadata is carried on the same
// values that drive runtime validation, so docs cannot drift from behavior.
//
// Coverage note: the ~15 genuinely irregular actions in `actions/extended.ts`
// that remain on the legacy `h.registerAction(...)` path are NOT ActionSpecs
// and so do not appear here — that is the documented irregular tail.
//
// The serving SURFACE (WebUI panel / OpenAPI export / static markdown) is a
// deferred product decision; this module produces format-agnostic data plus a
// Markdown default. Point any renderer at `collectActionDocs()`.

import type { ActionDoc } from './action-kit';
import { ACTION_GROUPS } from './actions';

/** Every declarative action's doc (with category), sorted by name. */
export function collectActionDocs(): ActionDoc[] {
  return ACTION_GROUPS
    .flatMap(({ category, actions }) => actions.map((s) => ({ ...s.describe(), category })))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Distinct categories with action counts. */
export function collectCategories(): Array<{ category: string; count: number }> {
  return ACTION_GROUPS.map(({ category, actions }) => ({ category, count: actions.length }));
}

function paramRow(p: ActionDoc['params'][number]): string {
  const type = p.values ? p.values.map((v) => JSON.stringify(v)).join(' \\| ') : p.type;
  const required = p.required ? '✓' : '–';
  const def = !p.required && p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : '';
  return `| \`${p.name}\` | ${type} | ${required} | ${def} | ${p.desc ?? ''} |`;
}

function renderAction(doc: ActionDoc): string {
  const lines: string[] = [];
  const alias = doc.aliases.length ? `  _(别名: ${doc.aliases.map((a) => `\`${a}\``).join(', ')})_` : '';
  const cat = doc.category ? ` · ${doc.category}` : '';
  lines.push(`### \`${doc.name}\`${cat}${alias}`);
  if (doc.summary) lines.push('', doc.summary);
  if (doc.params.length) {
    lines.push('', '| 参数 | 类型 | 必填 | 默认 | 说明 |', '| --- | --- | --- | --- | --- |');
    for (const p of doc.params) lines.push(paramRow(p));
  } else {
    lines.push('', '_无参数_');
  }
  if (doc.invariants.length) lines.push('', `**约束:** ${doc.invariants.map((i) => `\`${i}\``).join('；')}`);
  if (doc.returns) lines.push('', `**返回:** \`${doc.returns}\``);
  return lines.join('\n');
}

/** Render the full Markdown doc. */
export function renderActionDocsMarkdown(docs: readonly ActionDoc[] = collectActionDocs()): string {
  const header = [
    '# OneBot Actions',
    '',
    '> 由 `packages/onebot/src/action-docs.ts` 从各 `ActionSpec.describe()` 自动生成，请勿手改。',
    '> 仅覆盖声明式 action；`extended.ts` 中少量走 legacy `registerAction` 的不规则 action 不在此列。',
    '',
    `共 ${docs.length} 个声明式 action。`,
    '',
  ];
  return header.concat(docs.map(renderAction)).join('\n') + '\n';
}
