import * as globalConfig from '../src/global-config';
import {
    getVideoUploadConcurrency,
    setVideoUploadConcurrency,
} from '@snowluma/protocol/highway/upload-settings';
import { currentRequestId, runWithRequestId } from '@snowluma/common/logger';
import { describe, expect, it, vi } from 'vitest';
import { OneBotManager } from '../src/manager';
import type { OneBotConfig } from '../src/types';

function config(trigger: string): OneBotConfig {
    return {
        networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger },
        historySync: { enabled: false },
        notifications: { channelIds: [] },
    };
}

describe('OneBotManager config apply value ownership', () => {
    it('applies video concurrency at startup and reloads it even with no active accounts', () => {
        const load = vi.spyOn(globalConfig, 'loadGlobalSettings').mockReturnValue({
            ...globalConfig.defaultGlobalSettings(),
            videoUploadConcurrency: 3,
        });

        try {
            const manager = new OneBotManager();
            expect(getVideoUploadConcurrency()).toBe(3);
            load.mockReturnValue({
                ...globalConfig.defaultGlobalSettings(),
                videoUploadConcurrency: 2,
            });
            manager.reloadGlobalSettings();
            expect(getVideoUploadConcurrency()).toBe(2);
        } finally {
            load.mockRestore();
            setVideoUploadConcurrency(1);
        }
    });

    it('passes each concurrent caller exact config value to the instance', async () => {
        const manager = new OneBotManager();
        const seen: OneBotConfig[] = [];
        const instance = {
            reloadConfig: vi.fn(async (value: OneBotConfig) => {
                seen.push(value);
                return { applied: true, errors: [], statuses: [] };
            }),
        };
        (manager as unknown as { instances: Map<string, unknown> }).instances.set(
            '10001',
            instance,
        );
        const a = config('#a');
        const b = config('#b');

        await Promise.all([manager.reloadConfig('10001', a), manager.reloadConfig('10001', b)]);

        expect(seen).toEqual([a, b]);
        expect(instance.reloadConfig).toHaveBeenNthCalledWith(1, a);
        expect(instance.reloadConfig).toHaveBeenNthCalledWith(2, b);
    });

    it('does not attach a caller operation to reconfigured network resources', async () => {
        const manager = new OneBotManager();
        const observedRequestIds: Array<number | undefined> = [];
        let observeDeferred!: () => void;
        const instance = {
            reloadConfig: vi.fn(async () => {
                observedRequestIds.push(currentRequestId());
                observeDeferred = () => observedRequestIds.push(currentRequestId());
                return { applied: true, errors: [], statuses: [] };
            }),
        };
        (manager as unknown as { instances: Map<string, unknown> }).instances.set(
            '10001',
            instance,
        );

        await runWithRequestId(5101, () => manager.reloadConfig('10001', config('#reload')));
        observeDeferred();

        expect(observedRequestIds).toEqual([undefined, undefined]);
    });
});
