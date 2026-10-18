import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    type ReactNode,
} from 'react';

import {
    debugTasksReducer,
    type DebugTask,
    type DebugTaskStatus,
    type DebugTaskUpdate,
} from '@/lib/debug-tasks';
export type { DebugTask, DebugTaskStatus, DebugTaskKind } from '@/lib/debug-tasks';

interface DebugTaskContextValue {
    tasks: DebugTask[];
    /** Register a task; returns its id. */
    start: (
        task: Omit<DebugTask, 'id' | 'status' | 'startedAt' | 'endedAt'> & { id?: string },
    ) => string;
    update: (id: string, patch: DebugTaskUpdate) => void;
    /** Mark terminal (done/failed/canceled) and stamp endedAt. */
    finish: (id: string, status: Exclude<DebugTaskStatus, 'running'>, detail?: string) => void;
    remove: (id: string) => void;
    clearFinished: () => void;
}

const Ctx = createContext<DebugTaskContextValue | null>(null);

let seq = 0;
const nextId = () => `dt-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function DebugTaskProvider({ children }: { children: ReactNode }) {
    const [tasks, dispatch] = useReducer(debugTasksReducer, []);

    const start = useCallback<DebugTaskContextValue['start']>((t) => {
        const id = t.id ?? nextId();
        dispatch({ type: 'start', task: { ...t, id, status: 'running', startedAt: Date.now() } });
        return id;
    }, []);

    const update = useCallback<DebugTaskContextValue['update']>((id, patch) => {
        dispatch({ type: 'update', id, patch });
    }, []);

    const finish = useCallback<DebugTaskContextValue['finish']>((id, status, detail) => {
        dispatch({ type: 'finish', id, status, detail, endedAt: Date.now() });
    }, []);

    const remove = useCallback<DebugTaskContextValue['remove']>((id) => {
        dispatch({ type: 'remove', id });
    }, []);

    const clearFinished = useCallback(() => {
        dispatch({ type: 'clearFinished' });
    }, []);

    const anyRunning = tasks.some((task) => task.status === 'running');
    useEffect(() => {
        if (!anyRunning) {
            return;
        }

        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = '';
        };

        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [anyRunning]);

    const value = useMemo<DebugTaskContextValue>(
        () => ({ tasks, start, update, finish, remove, clearFinished }),
        [tasks, start, update, finish, remove, clearFinished],
    );
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDebugTasks(): DebugTaskContextValue {
    const v = useContext(Ctx);

    if (!v) {
        throw new Error('useDebugTasks must be used within DebugTaskProvider');
    }

    return v;
}

/** Convenience: count + aggregate progress of running tasks, for the badge. */
export function useRunningTaskSummary(): { count: number; progress: number | null } {
    const { tasks } = useDebugTasks();
    return useMemo(() => {
        let count = 0;
        let determinate = 0;
        let total = 0;

        for (const task of tasks) {
            if (task.status !== 'running') {
                continue;
            }

            count++;

            if (task.progress !== undefined) {
                determinate++;
                total += task.progress;
            }
        }

        return { count, progress: determinate ? total / determinate : null };
    }, [tasks]);
}
