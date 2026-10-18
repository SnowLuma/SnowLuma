import { describe, expect, it } from 'vitest';
import { debugTasksReducer, type DebugTask } from '../src/lib/debug-tasks';

function running(id: string): DebugTask {
    return { id, kind: 'upload', label: id, status: 'running', startedAt: 1, progress: 0 };
}

describe('debug task lifecycle', () => {
    it('keeps the first terminal result when late progress or completion arrives', () => {
        const finished = debugTasksReducer([running('a')], {
            type: 'finish',
            id: 'a',
            status: 'canceled',
            detail: 'Canceled',
            endedAt: 2,
        });
        const updated = debugTasksReducer(finished, {
            type: 'update',
            id: 'a',
            patch: { progress: 1 },
        });
        const completed = debugTasksReducer(updated, {
            type: 'finish',
            id: 'a',
            status: 'done',
            endedAt: 3,
        });
        expect(completed).toEqual(finished);
    });

    it('cannot dismiss running tasks or lose them while clearing history', () => {
        const task = running('a');
        expect(debugTasksReducer([task], { type: 'remove', id: 'a' })).toEqual([task]);
        expect(debugTasksReducer([task], { type: 'clearFinished' })).toEqual([task]);
    });

    it('keeps every running task and trims history as they finish', () => {
        let tasks: DebugTask[] = [];

        for (let i = 0; i < 55; i++) {
            tasks = debugTasksReducer(tasks, { type: 'start', task: running(String(i)) });
        }

        expect(tasks).toHaveLength(55);

        for (let i = 0; i < 55; i++) {
            tasks = debugTasksReducer(tasks, {
                type: 'finish',
                id: String(i),
                status: 'done',
                endedAt: 2,
            });
        }

        expect(tasks).toHaveLength(50);
        expect(tasks.every((task) => task.status === 'done')).toBe(true);
        expect(tasks.some((task) => task.id === '0')).toBe(false);
    });

    it('releases cancellation and removes only completed tasks', () => {
        const tasks = debugTasksReducer(
            [{ ...running('a'), cancel: () => undefined }, running('b')],
            {
                type: 'finish',
                id: 'a',
                status: 'failed',
                detail: 'Upload failed',
                endedAt: 2,
            },
        );
        expect(tasks[0]).toMatchObject({
            status: 'failed',
            detail: 'Upload failed',
            endedAt: 2,
            cancel: undefined,
        });
        expect(debugTasksReducer(tasks, { type: 'remove', id: 'a' })).toEqual([running('b')]);
    });
});
