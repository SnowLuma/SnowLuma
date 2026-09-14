import { describe, expect, it } from 'vitest';
import { migrateOverviewBlocks } from '../src/lib/dashboard-layout';

describe('migrateOverviewBlocks', () => {
  it('preserves saved widget configuration while restoring the grid', () => {
    const migrated = migrateOverviewBlocks([
      {
        id: 'account',
        visible: true,
        x: 8,
        y: 14,
        w: 4,
        h: 1,
        config: { uin: '123456789' },
      },
    ]);

    expect(migrated.find((item) => item.id === 'account')).toEqual({
      id: 'account',
      visible: true,
      x: 8,
      y: 14,
      w: 4,
      h: 1,
      config: { uin: '123456789' },
    });
  });
});
