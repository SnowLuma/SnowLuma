export type DebugTaskStatus = 'running' | 'done' | 'failed' | 'canceled';
export type DebugTaskKind = 'upload' | 'stream' | 'invoke';

export interface DebugTask {
    id: string;
    kind: DebugTaskKind;
    label: string;
    status: DebugTaskStatus;
    /** 0..1; undefined means indeterminate. */
    progress?: number;
    detail?: string;
    startedAt: number;
    endedAt?: number;
    cancel?: () => void;
}

export type DebugTaskUpdate = Partial<Pick<DebugTask, 'progress' | 'detail' | 'label'>>;
export type DebugTaskAction =
    | { type: 'start'; task: DebugTask }
    | { type: 'update'; id: string; patch: DebugTaskUpdate }
    | {
          type: 'finish';
          id: string;
          status: Exclude<DebugTaskStatus, 'running'>;
          detail?: string;
          endedAt: number;
      }
    | { type: 'remove'; id: string }
    | { type: 'clearFinished' };

function trimFinished(tasks: DebugTask[]): DebugTask[] {
    let remaining = Math.max(0, 50 - tasks.filter((task) => task.status === 'running').length);
    return tasks.filter((task) => task.status === 'running' || remaining-- > 0);
}

export function debugTasksReducer(tasks: DebugTask[], action: DebugTaskAction): DebugTask[] {
    switch (action.type) {
        case 'start':
            return trimFinished([action.task, ...tasks]);
        case 'update':
            return tasks.map((task) =>
                task.id === action.id && task.status === 'running'
                    ? { ...task, ...action.patch }
                    : task,
            );
        case 'finish':
            return trimFinished(
                tasks.map((task) =>
                    task.id === action.id && task.status === 'running'
                        ? {
                              ...task,
                              status: action.status,
                              detail: action.detail ?? task.detail,
                              endedAt: action.endedAt,
                              cancel: undefined,
                          }
                        : task,
                ),
            );
        case 'remove':
            return tasks.filter((task) => task.id !== action.id || task.status === 'running');
        case 'clearFinished':
            return tasks.filter((task) => task.status === 'running');
    }
}
