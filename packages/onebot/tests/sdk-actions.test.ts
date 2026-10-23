import { describe, expect, it } from 'vitest';
import { SNOWLUMA_ACTIONS, isSnowLumaAction } from '../../sdk/src/actions.js';
import { ACTION_REGISTRY } from '../src/actions';

describe('SDK action catalog compatibility', () => {
    it('covers every executable name, including aliases and raw actions, exactly once', () => {
        const registered = ACTION_REGISTRY.executableNames.map(({ name }) => name);
        expect([...SNOWLUMA_ACTIONS].sort()).toEqual(registered.sort());
        expect(new Set(SNOWLUMA_ACTIONS).size).toBe(SNOWLUMA_ACTIONS.length);

        for (const name of registered) {
            expect(isSnowLumaAction(name), name).toBe(true);
        }
    });

    it.each(['', 'consumer_extension', 'SEND_GROUP_MSG', 'send_group_msg '])(
        'does not recognize unregistered name %j',
        (name) => {
            expect(isSnowLumaAction(name)).toBe(false);
        },
    );
});
