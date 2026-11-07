import type { ActionFeedbackHandle } from '@/contexts/ActionFeedbackContext';
import type { UpdateStatus } from '@/types';

export function createUpdateFeedback(
    activity: ActionFeedbackHandle | null,
    onPollingError: (message: string) => void,
) {
    let pollingErrorReported = false;
    let terminalReported = false;

    return {
        status(next: UpdateStatus) {
            if (terminalReported) {
                return;
            }

            if (next.phase === 'ready') {
                activity?.succeed({ title: '更新已就绪', detail: '重启后生效' });
                terminalReported = true;
            } else if (next.phase === 'error') {
                activity?.fail(next.message, { title: '更新失败' });
                terminalReported = true;
            }
        },
        pollingError(message: string) {
            if (pollingErrorReported || terminalReported) {
                return;
            }

            onPollingError(message);
            pollingErrorReported = true;
        },
        dispose() {
            if (activity && !terminalReported && !pollingErrorReported) {
                activity.succeed({ title: '更新继续在后台进行', detail: '返回关于页面查看结果' });
                terminalReported = true;
            }
        },
    };
}
