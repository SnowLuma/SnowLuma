// Interface tests for action-kit — the deepened param-validation module.
// The interface IS the test surface: we drive `parse()` (pure, no ctx) for
// coercion/validation/cross-field, `describe()` for doc metadata, and
// `toHandler()` for the BAD_REQUEST shaping + ctx threading.

import { describe, it, expect } from 'vitest';
import { f, defineAction, groupUserAction, type CoerceResult } from '../src/action-kit';
import type { ApiActionContext } from '../src/api-handler';
import { RETCODE, okResponse } from '../src/types';

const ctx = {} as unknown as ApiActionContext;

function expectErr<T>(r: CoerceResult<T>): { field: string; reason: string } {
  if (r.ok) throw new Error(`expected Err, got Ok(${JSON.stringify(r.value)})`);
  return { field: r.field, reason: r.reason };
}
function expectOk<T>(r: CoerceResult<T>): T {
  if (!r.ok) throw new Error(`expected Ok, got Err(${r.field}: ${r.reason})`);
  return r.value;
}

describe('f.uint — positive integer, missing≠0', () => {
  const spec = defineAction({ name: 't', params: { x: f.uint() }, run: () => okResponse() });
  it('accepts number and numeric string, truncates', () => {
    expect(expectOk(spec.parse({ x: 123 }))).toEqual({ x: 123 });
    expect(expectOk(spec.parse({ x: '456' }))).toEqual({ x: 456 });
    expect(expectOk(spec.parse({ x: 5.7 }))).toEqual({ x: 5 });
  });
  it('rejects missing / 0 / negative / garbage, naming the field', () => {
    expect(expectErr(spec.parse({})).field).toBe('x');
    expect(expectErr(spec.parse({})).reason).toBe('is required');
    expect(expectErr(spec.parse({ x: 0 })).field).toBe('x'); // 0 is not a valid id
    expect(expectErr(spec.parse({ x: -3 })).field).toBe('x');
    expect(expectErr(spec.parse({ x: 'abc' })).field).toBe('x');
  });
});

describe('f.int({min:0}).default — the duration / unmute fix', () => {
  const spec = defineAction({ name: 't', params: { d: f.int({ min: 0 }).default(1800) }, run: () => okResponse() });
  it('missing ⇒ default; present 0 ⇒ 0 (not the default); negative ⇒ err', () => {
    expect(expectOk(spec.parse({}))).toEqual({ d: 1800 });
    expect(expectOk(spec.parse({ d: 0 }))).toEqual({ d: 0 }); // the bug the old `|| 1800` had
    expect(expectErr(spec.parse({ d: -1 })).field).toBe('d');
  });
  it('present garbage is an error, not a silent fallback', () => {
    expect(expectErr(spec.parse({ d: 'abc' })).field).toBe('d');
  });
});

describe('f.messageId — non-zero integer, negatives allowed', () => {
  const spec = defineAction({ name: 't', params: { id: f.messageId() }, run: () => okResponse() });
  it('accepts negative ids (signed int32 hash), rejects 0 and garbage', () => {
    expect(expectOk(spec.parse({ id: -2147483648 }))).toEqual({ id: -2147483648 });
    expect(expectOk(spec.parse({ id: 123 }))).toEqual({ id: 123 });
    expect(expectErr(spec.parse({ id: 0 })).reason).toBe('must not be 0');
    expect(expectErr(spec.parse({ id: 'x' })).field).toBe('id');
  });
});

describe('f.bool / f.string / f.enum', () => {
  it('bool synonyms', () => {
    const s = defineAction({ name: 't', params: { b: f.bool() }, run: () => okResponse() });
    expect(expectOk(s.parse({ b: 'on' }))).toEqual({ b: true });
    expect(expectOk(s.parse({ b: 0 }))).toEqual({ b: false });
    expect(expectErr(s.parse({ b: 'maybe' })).field).toBe('b');
  });
  it('string allowEmpty toggle', () => {
    const s = defineAction({ name: 't', params: { c: f.string({ allowEmpty: false }) }, run: () => okResponse() });
    expect(expectErr(s.parse({ c: '' })).field).toBe('c');
    expect(expectOk(s.parse({ c: 'x' }))).toEqual({ c: 'x' });
  });
  it('enum literal set', () => {
    const s = defineAction({ name: 't', params: { e: f.enum('a', 'b') }, run: () => okResponse() });
    expect(expectOk(s.parse({ e: 'a' }))).toEqual({ e: 'a' });
    expect(expectErr(s.parse({ e: 'c' })).field).toBe('e');
  });
});

describe('f.array(...).nonEmpty — per-element + non-empty', () => {
  const spec = defineAction({ name: 't', params: { ids: f.array(f.uint()).nonEmpty() }, run: () => okResponse() });
  it('accepts a non-empty uint array', () => {
    expect(expectOk(spec.parse({ ids: [1, 2, 3] }))).toEqual({ ids: [1, 2, 3] });
  });
  it('rejects empty and names the bad element index', () => {
    expect(expectErr(spec.parse({ ids: [] })).field).toBe('ids');
    expect(expectErr(spec.parse({ ids: [1, 'x'] })).field).toBe('ids[1]');
  });
});

describe('f.message — union passthrough + JSON-array string', () => {
  const spec = defineAction({ name: 't', params: { m: f.message() }, run: () => okResponse() });
  it('parses a JSON-array string, passes plain string / array through', () => {
    expect(expectOk(spec.parse({ m: '[{"type":"text","data":{"text":"hi"}}]' })).m).toEqual([
      { type: 'text', data: { text: 'hi' } },
    ]);
    expect(expectOk(spec.parse({ m: 'hello' })).m).toBe('hello');
    expect(expectOk(spec.parse({ m: [{ type: 'face' }] })).m).toEqual([{ type: 'face' }]);
  });
  it('required when missing', () => {
    expect(expectErr(spec.parse({})).reason).toBe('is required');
  });
});

describe('optional fields', () => {
  const spec = defineAction({ name: 't', params: { x: f.uint().optional() }, run: () => okResponse() });
  it('missing ⇒ undefined value, present-invalid ⇒ err', () => {
    expect(expectOk(spec.parse({}))).toEqual({ x: undefined });
    expect(expectErr(spec.parse({ x: 'abc' })).field).toBe('x');
  });
});

describe('cross-field rules', () => {
  const spec = defineAction({
    name: 'set_msg_emoji_like',
    params: {
      message_id: f.uint().optional(),
      group_id: f.uint().optional(),
      user_id: f.uint().optional(),
      emoji_id: f.uint(),
    },
    rules: (r) => [r.exactlyOneOf('message_id', ['group_id', 'user_id'])],
    run: () => okResponse(),
  });
  it('passes when exactly one locator group present', () => {
    expect(spec.parse({ message_id: 5, emoji_id: 1 }).ok).toBe(true);
    expect(spec.parse({ group_id: 9, user_id: 8, emoji_id: 1 }).ok).toBe(true);
  });
  it('fails when zero or both groups present', () => {
    expect(expectErr(spec.parse({ emoji_id: 1 })).reason).toContain('exactly one of');
    expect(expectErr(spec.parse({ message_id: 5, group_id: 9, user_id: 8, emoji_id: 1 })).reason).toContain('exactly one of');
  });
  it('field errors take priority over rule errors (per-field first)', () => {
    expect(expectErr(spec.parse({ emoji_id: 0 })).field).toBe('emoji_id');
  });
});

describe('toHandler — BAD_REQUEST shaping + ctx threading', () => {
  const spec = groupUserAction({
    name: 'set_group_ban',
    params: { duration: f.int({ min: 0 }).default(1800) },
    run: (p) => okResponse({ seen: [p.group_id, p.user_id, p.duration] }),
  });
  it('success path returns run output with typed/defaulted params', async () => {
    const res = await spec.toHandler(ctx)({ group_id: 10, user_id: 20 });
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { seen: [10, 20, 1800] } });
  });
  it('bad params ⇒ BAD_REQUEST naming the field (not INTERNAL_ERROR)', async () => {
    const res = await spec.toHandler(ctx)({ user_id: 20 }); // missing group_id
    expect(res.retcode).toBe(RETCODE.BAD_REQUEST);
    expect(res.status).toBe('failed');
    expect(res.wording).toContain('group_id');
  });
});

describe('run raw escape hatch — original params as 3rd arg', () => {
  it('exposes untouched params for undeclared keys (alias fallbacks etc.)', async () => {
    const spec = defineAction({
      name: 't',
      params: { user_id: f.uint() },
      run: (_p, _ctx, raw) => okResponse({ extra: (raw.long_nick ?? raw.longNick ?? null) as never }),
    });
    const res = await spec.toHandler(ctx)({ user_id: 1, longNick: 'hi' });
    expect(res).toMatchObject({ status: 'ok', data: { extra: 'hi' } });
  });
});

describe('toJsonSchema / inputSchema (for the MCP)', () => {
  it('emits a JSON Schema fragment per coercer', () => {
    expect(f.uint().toJsonSchema()).toEqual({ type: 'integer', minimum: 1 });
    expect(f.messageId().toJsonSchema()).toEqual({ type: 'integer', not: { const: 0 } });
    expect(f.int({ min: 0 }).default(1800).toJsonSchema()).toEqual({ type: 'integer', minimum: 0, default: 1800 });
    expect(f.string({ allowEmpty: false }).toJsonSchema()).toEqual({ type: 'string', minLength: 1 });
    expect(f.bool().toJsonSchema()).toEqual({ type: 'boolean' });
    expect(f.enum('a', 'b').toJsonSchema()).toEqual({ enum: ['a', 'b'] });
    expect(f.array(f.uint()).nonEmpty().toJsonSchema()).toEqual({
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
    });
    expect(f.uint().describe('群号').toJsonSchema()).toEqual({ type: 'integer', minimum: 1, description: '群号' });
  });

  it('composes an action inputSchema (object + required + defaults)', () => {
    const spec = groupUserAction({
      name: 'set_group_ban',
      params: { duration: f.int({ min: 0 }).default(1800) },
      run: () => okResponse(),
    });
    const { inputSchema } = spec.describe();
    expect(inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: true,
      required: ['group_id', 'user_id'],
      properties: {
        group_id: { type: 'integer', minimum: 1 },
        user_id: { type: 'integer', minimum: 1 },
        duration: { type: 'integer', minimum: 0, default: 1800 },
      },
    });
  });
});

describe('describe — doc metadata for self-generated docs (D4)', () => {
  const spec = groupUserAction({
    name: ['set_group_ban', 'ban'],
    summary: 'Mute a member',
    params: { duration: f.int({ min: 0 }).default(1800).describe('seconds; 0 unmutes') },
    run: () => okResponse(),
  });
  it('exposes name, aliases, and per-param metadata (incl. preset-injected fields)', () => {
    const doc = spec.describe();
    expect(doc.name).toBe('set_group_ban');
    expect(doc.aliases).toEqual(['ban']);
    expect(doc.summary).toBe('Mute a member');
    const names = doc.params.map((p) => p.name);
    expect(names).toEqual(['group_id', 'user_id', 'duration']); // presets surfaced
    const duration = doc.params.find((p) => p.name === 'duration');
    expect(duration).toMatchObject({ type: 'int', required: false, default: 1800, desc: 'seconds; 0 unmutes' });
  });
});
