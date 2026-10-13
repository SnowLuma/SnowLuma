import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/interior/modal';
import { Button } from '@/components/ui/button';
import {
    LOW_INTEGRITY_PERMANENT_KEY,
    readLowIntegrityDismissed,
    saveLowIntegrityDismissed,
} from '@/lib/low-integrity-warning';

/** Mounted in the authenticated layout so polling and route changes cannot reopen it. */
export function LowIntegrityWarning({ lowIntegrity }: { lowIntegrity: boolean }) {
    const [dismissed, setDismissed] = useState(readLowIntegrityDismissed);
    const [error, setError] = useState<string | null>(null);
    const temporaryButton = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === LOW_INTEGRITY_PERMANENT_KEY && event.newValue === '1') {
                setDismissed(true);
            }
        };

        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const dismiss = (scope: 'session' | 'permanent') => {
        try {
            saveLowIntegrityDismissed(scope);
        } catch (caught) {
            console.warn('failed to save low integrity warning preference', caught);

            if (scope === 'permanent') {
                setError('无法保存设置，请允许浏览器存储或选择临时关闭。');
                return;
            }
            // Even with storage blocked, temporary dismissal must let the user continue.
        }

        setError(null);
        setDismissed(true);
    };

    return (
        <Modal
            open={lowIntegrity && !dismissed}
            onClose={() => dismiss('session')}
            title={
                <span className="flex items-center gap-2">
                    <AlertTriangle className="size-5 text-warning" />
                    Node 完整性过低
                </span>
            }
            showClose={false}
            closeOnBackdrop={false}
            initialFocusRef={temporaryButton}
            maxWidth={480}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={() => dismiss('permanent')}>
                        永久关闭
                    </Button>
                    <Button ref={temporaryButton} type="button" onClick={() => dismiss('session')}>
                        临时关闭
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <p>
                    当前进程可能无法连接
                    QQ。请检查启动程序的完整性标签，修正后重启。详情见启动日志。
                </p>
                <p className="text-xs text-muted-foreground">
                    临时关闭仅对当前标签页会话有效；永久关闭保存在此浏览器。
                </p>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
            </div>
        </Modal>
    );
}
