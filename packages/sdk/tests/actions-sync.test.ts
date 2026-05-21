import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SNOWLUMA_ACTIONS } from '../src';

describe('SnowLuma action list', () => {
  it('stays in sync with core registerAction calls', () => {
    // Actions moved out of @snowluma/core into the dedicated
    // @snowluma/onebot package in the RoadMap #3 4-way split.
    const actionsDir = fileURLToPath(new URL('../../onebot/src/actions/', import.meta.url));
    const registered = new Set<string>();

    for (const file of fs.readdirSync(actionsDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = fs.readFileSync(new URL(file, `file://${actionsDir}/`), 'utf8');
      for (const match of source.matchAll(/registerAction\('([^']+)'/g)) {
        registered.add(match[1]!);
      }
    }

    expect([...SNOWLUMA_ACTIONS].sort()).toEqual([...registered].sort());
  });
});
