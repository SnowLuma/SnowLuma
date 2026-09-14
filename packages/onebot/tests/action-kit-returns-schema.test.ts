// Tests the optional returnsSchema doc metadata: it must round-trip through
// describe() (on both defineAction and the group* presets) and stay absent
// when not provided. Semantics: returnsSchema describes the `data` payload
// inside the OneBot envelope, not the envelope.
import { describe, it, expect } from 'vitest';
import { defineAction, groupAction, f } from '../src/action-kit';
import { okResponse } from '../src/types';

describe('returnsSchema', () => {
  const dataSchema = {
    type: 'object',
    properties: { group_id: { type: 'integer' }, group_name: { type: 'string' } },
    required: ['group_id', 'group_name'],
  };

  it('round-trips returnsSchema through describe() on defineAction', () => {
    const spec = defineAction({
      name: 'demo_get',
      summary: 'demo',
      readOnly: true,
      returns: '群信息对象',
      returnsSchema: dataSchema,
      params: { x: f.uint() },
      run: () => okResponse({ ok: true }),
    });
    expect(spec.describe().returnsSchema).toEqual(dataSchema);
    expect(spec.describe().returns).toBe('群信息对象');
  });

  it('omits returnsSchema when not provided', () => {
    const spec = defineAction({
      name: 'demo_noschema',
      params: {},
      run: () => okResponse(null),
    });
    expect(spec.describe().returnsSchema).toBeUndefined();
  });

  it('carries returnsSchema through groupAction preset', () => {
    const spec = groupAction({
      name: 'demo_group_get',
      readOnly: true,
      returnsSchema: dataSchema,
      run: () => okResponse({}),
    });
    expect(spec.describe().returnsSchema).toEqual(dataSchema);
  });
});
