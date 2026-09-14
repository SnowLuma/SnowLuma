// TaskBadge — the app-wide floating indicator for in-flight debug tasks. Sits
// bottom-right on every page so a streaming upload/download stays visible after
// you switch tabs. Collapsed: a chip with a ring-progress + count. Expanded: a
// list with per-task progress, cancel (running) / dismiss (finished). Renders
// nothing when there are no tasks at all.
import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import { useDebugTasks, useRunningTaskSummary, type DebugTask } from '@/contexts/DebugTaskContext';
import { cn } from '@/lib/utils';

function StatusIcon({ status }: { status: DebugTask['status'] }) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  return <XCircle className="h-3.5 w-3.5 text-destructive" />;
}

function Row({ task, onDismiss }: { task: DebugTask; onDismiss: () => void }) {
  const pct = typeof task.progress === 'number' ? Math.round(task.progress * 100) : null;
  return (
    <div className="flex flex-col gap-1 rounded-lg px-2.5 py-2 hover:bg-muted/50">
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate text-foreground/90">{task.label}</span>
        {task.status === 'running' && task.cancel
          ? <button type="button" onClick={task.cancel} className="text-muted-foreground hover:text-destructive" title="取消"><X className="h-3.5 w-3.5" /></button>
          : <button type="button" onClick={onDismiss} className="text-muted-foreground hover:text-foreground" title="移除"><X className="h-3.5 w-3.5" /></button>}
      </div>
      {task.status === 'running' && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full bg-primary transition-[width] duration-300 ease-out', pct === null && 'animate-pulse')}
            style={{ width: pct === null ? '40%' : `${pct}%` }}
          />
        </div>
      )}
      {task.detail && task.status !== 'running' && (
        <span className="truncate text-xs text-muted-foreground" title={task.detail}>{task.detail}</span>
      )}
    </div>
  );
}

export function TaskBadge() {
  const { tasks, remove, clearFinished } = useDebugTasks();
  const { count, progress } = useRunningTaskSummary();
  const [open, setOpen] = useState(false);

  if (tasks.length === 0) return null;

  const ringPct = progress === null ? null : Math.round(progress * 100);

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 480, damping: 36 }}
            className="w-72 overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-xl ring-1 ring-black/5"
          >
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
              <span className="text-xs font-semibold">调试任务</span>
              {tasks.some((t) => t.status !== 'running') && (
                <button type="button" onClick={clearFinished} className="text-xs text-muted-foreground hover:text-foreground">清除已完成</button>
              )}
            </div>
            <div className="max-h-72 overflow-auto p-1.5">
              {tasks.map((t) => <Row key={t.id} task={t} onDismiss={() => remove(t.id)} />)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-border/60 bg-card/90 px-3 py-2 text-xs font-medium shadow-lg ring-1 ring-black/5 backdrop-blur transition-colors hover:bg-card"
      >
        {count > 0 ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <CheckCircle2 className="h-4 w-4 text-success" />}
        {count > 0
          ? <span>{count} 个任务进行中{ringPct !== null ? ` · ${ringPct}%` : ''}</span>
          : <span className="text-muted-foreground">任务完成</span>}
      </button>
    </div>
  );
}
