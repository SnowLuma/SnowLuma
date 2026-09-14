import { describe, expect, it, vi } from 'vitest';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';

describe('ApiHandler lifecycle ingress', () => {
  it('permanently rejects new Actions after quiesce', async () => {
    const run = vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null }));
    const handler = createCompiledTestHandler({} as never, [testAction('probe', run)], 10001);

    expect(handler.isAcceptingActions).toBe(true);
    handler.quiesce();
    handler.quiesce();

    await expect(handler.handle('probe', {})).resolves.toMatchObject({
      status: 'failed',
      retcode: 100,
      wording: 'OneBot instance is shutting down',
    });
    expect(handler.isAcceptingActions).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
