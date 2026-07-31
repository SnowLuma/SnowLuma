import { useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import {
  actionErrorMessage,
  useActionFeedback,
  type ActionFeedbackOptions,
} from '@/contexts/ActionFeedbackContext';
import { cn } from '@/lib/utils';

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
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription asChild>
              <div>{description}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {error && (
          <div role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {content}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            disabled={busy || confirmDisabled}
          >
            {busy ? '处理中…' : confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
