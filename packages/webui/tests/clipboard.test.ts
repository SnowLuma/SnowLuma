import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/lib/utils';

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
    it('uses the clipboard API without creating a temporary element', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        vi.stubGlobal('document', undefined);

        await expect(copyText('hello')).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith('hello');
    });

    it.each(['success', 'rejected', 'focus throws', 'copy throws'])(
        'removes the temporary element after legacy copy: %s',
        async (outcome) => {
            const children = new Set<unknown>();
            const host = {
                appendChild: (child: unknown) => children.add(child),
                removeChild: (child: unknown) => children.delete(child),
            };
            const textarea = {
                value: '',
                style: {},
                setAttribute: vi.fn(),
                setSelectionRange: vi.fn(),
                focus: () => {
                    if (outcome === 'focus throws') {
                        throw new Error('focus unavailable');
                    }
                },
                remove: () => children.delete(textarea),
            };
            vi.stubGlobal('navigator', {
                clipboard: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
            });
            vi.stubGlobal('document', {
                body: host,
                createElement: () => textarea,
                querySelector: () => host,
                execCommand: () => {
                    if (outcome === 'copy throws') {
                        throw new Error('copy unavailable');
                    }

                    return outcome === 'success';
                },
            });

            await expect(copyText('hello')).resolves.toBe(outcome === 'success');
            expect(children.size).toBe(0);
        },
    );
});
