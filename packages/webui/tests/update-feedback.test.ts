import { describe, expect, it, vi } from 'vitest';
import { createUpdateFeedback } from '../src/lib/update-feedback';

function setup() {
    const activity = { update: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
    const pollingError = vi.fn();
    return { activity, pollingError, feedback: createUpdateFeedback(activity, pollingError) };
}

describe('update progress feedback', () => {
    it('reports a ready update after recovering from polling failures without duplicate notices', () => {
        const { activity, pollingError, feedback } = setup();
        feedback.pollingError('connection reset');
        feedback.pollingError('still offline');
        expect(pollingError).toHaveBeenCalledExactlyOnceWith('connection reset');
        feedback.status({ current: '2.4.2', phase: 'downloading', version: '2.5.0' });
        feedback.status({ current: '2.4.2', phase: 'ready', version: '2.5.0' });
        feedback.status({ current: '2.4.2', phase: 'ready', version: '2.5.0' });
        feedback.dispose();
        expect(activity.succeed).toHaveBeenCalledExactlyOnceWith({
            title: '更新已就绪',
            detail: '重启后生效',
        });
    });

    it('reports the actual download failure after a polling error', () => {
        const { activity, feedback } = setup();
        feedback.pollingError('connection reset');
        feedback.status({ current: '2.4.2', phase: 'error', message: 'SHA256 mismatch' });
        feedback.status({ current: '2.4.2', phase: 'error', message: 'SHA256 mismatch' });
        feedback.dispose();
        expect(activity.fail).toHaveBeenCalledExactlyOnceWith('SHA256 mismatch', {
            title: '更新失败',
        });
        expect(activity.succeed).not.toHaveBeenCalled();
    });

    it('explains a continuing download on disposal without claiming the update is ready', () => {
        const { activity, feedback } = setup();
        feedback.status({ current: '2.4.2', phase: 'downloading', version: '2.5.0' });
        feedback.dispose();
        feedback.dispose();
        expect(activity.succeed).toHaveBeenCalledExactlyOnceWith({
            title: '更新继续在后台进行',
            detail: '返回关于页面查看结果',
        });
    });

    it('does not replace a polling failure with a success notice when leaving the page', () => {
        const { activity, feedback } = setup();
        feedback.pollingError('connection reset');
        feedback.dispose();
        expect(activity.succeed).not.toHaveBeenCalled();
    });
});
