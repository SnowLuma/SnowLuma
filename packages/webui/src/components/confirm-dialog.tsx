import { useRef, useState, type ReactNode } from 'react';
import { Modal } from '@/components/interior/modal';
import { Button } from '@/components/ui/button';
import {
  actionErrorMessage,
  useActionFeedback,
  type ActionFeedbackOptions,
} from '@/contexts/ActionFeedbackContext';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  content?: ReactNode;
  confirmDisabled?: boolean;
  activity?: ActionFeedbackOptions<void>;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  destructive = false,
  content,
  confirmDisabled = false,
  activity,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { runAction } = useActionFeedback();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!activity) {
        await onConfirm();
      } else {
        await runAction(activity, onConfirm);
      }
      onOpenChange(false);
    } catch (caught) {
      const message = actionErrorMessage(caught);
      setError(message);
      console.error('confirm action failed', caught);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (busy && !nextOpen) return;
    if (!nextOpen) setError(null);
    onOpenChange(nextOpen);
  };

  return (
    <Modal
      open={open}
      onClose={() => handleOpenChange(false)}
      title={title}
      description={description}
      showClose={false}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      initialFocusRef={cancelRef}
      maxWidth={512}
      footer={(
        <>
          <Button ref={cancelRef} type="button" variant="outline" disabled={busy} onClick={() => handleOpenChange(false)}>
            {cancelText}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => { void handleConfirm(); }}
            disabled={busy || confirmDisabled}
          >
            {busy ? '处理中…' : confirmText}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {content}
      </div>
    </Modal>
  );
}
