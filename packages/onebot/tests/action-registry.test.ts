import { describe, expect, it, vi } from 'vitest';
import { defineAction, defineStreamAction, type RegisteredActionSpec } from '../src/action-kit';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import {
  ACTION_REGISTRY,
  HANDLE_QUICK_OPERATION_ACTION,
  RAW_ACTION_RESERVATIONS,
  compileActionRegistry,
  type ActionGroup,
  type RawActionReservation,
} from '../src/actions';
import { collectActionDocs } from '../src/action-docs';
import { okResponse } from '../src/types';

type ActionNames = string | readonly [string, ...string[]];

function normal(name: ActionNames): RegisteredActionSpec {
  return defineAction({ name, params: {}, run: () => okResponse() });
}

function stream(name: ActionNames): RegisteredActionSpec {
  return defineStreamAction({ name, params: {}, run: () => okResponse() });
}

function groups(...actions: RegisteredActionSpec[]): readonly ActionGroup[] {
  return [{ category: 'test', actions }];
}

function conflict(
  actionGroups: readonly ActionGroup[],
  raw: readonly RawActionReservation[] = [],
): string {
  try {
    compileActionRegistry(actionGroups, raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('expected registry compilation to fail');
}

describe('compileActionRegistry namespace conflicts', () => {
  it('rejects canonical ↔ canonical', () => {
    const message = conflict(groups(normal('shared'), normal('shared')));
    expect(message).toContain('executable name "shared"');
    expect(message).toContain('canonical "shared" (name "shared", kind normal, role canonical)');
  });

  it.each([
    ['canonical first', [normal('shared'), normal(['owner', 'shared'])]],
    ['alias first', [normal(['owner', 'shared']), normal('shared')]],
  ] as const)('rejects canonical ↔ alias (%s)', (_label, specs) => {
    const message = conflict(groups(...specs));
    expect(message).toContain('canonical "shared" (name "shared", kind normal, role canonical)');
    expect(message).toContain('canonical "owner" (name "shared", kind normal, role alias)');
  });

  it('rejects alias ↔ alias', () => {
    const message = conflict(groups(normal(['first', 'shared']), normal(['second', 'shared'])));
    expect(message).toContain('canonical "first" (name "shared", kind normal, role alias)');
    expect(message).toContain('canonical "second" (name "shared", kind normal, role alias)');
  });

  it('rejects normal ↔ stream and reports both kinds', () => {
    const message = conflict(groups(normal('shared'), stream('shared')));
    expect(message).toContain('canonical "shared" (name "shared", kind normal, role canonical)');
    expect(message).toContain('canonical "shared" (name "shared", kind stream, role canonical)');
  });

  it.each([
    ['canonical', normal(HANDLE_QUICK_OPERATION_ACTION), 'role canonical'],
    ['alias', normal(['owner', HANDLE_QUICK_OPERATION_ACTION]), 'role alias'],
  ] as const)('rejects a declarative %s colliding with a reserved raw action', (_label, spec, role) => {
    const message = conflict(groups(spec), [
      { name: HANDLE_QUICK_OPERATION_ACTION, canonical: HANDLE_QUICK_OPERATION_ACTION },
    ]);
    expect(message).toContain(`name "${HANDLE_QUICK_OPERATION_ACTION}"`);
    expect(message).toContain(`kind normal, ${role}`);
    expect(message).toContain('kind raw, role raw');
  });

  it('rejects duplicate raw reservations', () => {
    const message = conflict([], [
      { name: 'raw', canonical: 'first-raw' },
      { name: 'raw', canonical: 'second-raw' },
    ]);
    expect(message).toContain('canonical "first-raw" (name "raw", kind raw, role raw)');
    expect(message).toContain('canonical "second-raw" (name "raw", kind raw, role raw)');
  });
});

describe('compiled production Action registry', () => {
  it('preserves all 191 canonical Action docs', () => {
    expect(ACTION_REGISTRY.actions).toHaveLength(191);
    expect(collectActionDocs()).toHaveLength(191);
  });

  it('resolves every executable name to exactly one canonical doc', () => {
    const docs = new Map(collectActionDocs().map((doc) => [doc.name, doc]));

    for (const executable of ACTION_REGISTRY.executableNames) {
      expect(ACTION_REGISTRY.resolve(executable.name)).toBe(executable);
      if (executable.kind === 'raw') {
        expect(executable.name).toBe(HANDLE_QUICK_OPERATION_ACTION);
        expect(docs.has(executable.canonical)).toBe(false);
        continue;
      }

      const doc = docs.get(executable.canonical);
      expect(doc, executable.name).toBeDefined();
      expect(executable.action.doc).toEqual(doc);
      expect(executable.action.kind).toBe(doc!.stream === true ? 'stream' : 'normal');
      expect([doc!.name, ...doc!.aliases]).toContain(executable.name);
    }
  });

  it('binds the exact compiled executable-name/kind projection', () => {
    const api = { handle: vi.fn() } as unknown as ApiHandler;
    const bound = ACTION_REGISTRY.bind({} as ApiActionContext, api, {
      [HANDLE_QUICK_OPERATION_ACTION]: () => async () => okResponse(),
    });

    expect([...bound.entries()].map(([name, entry]) => [name, entry.kind])).toEqual(
      ACTION_REGISTRY.executableNames.map((entry) => [entry.name, entry.kind]),
    );
    for (const executable of ACTION_REGISTRY.executableNames) {
      expect(bound.get(executable.name)?.canonical).toBe(executable.canonical);
    }
  });

  it('validates and forwards get_group_system_msg filters', async () => {
    const handleGetGroupSystemMsg = vi.fn(async () => []);
    const handler = new ApiHandler({ handleGetGroupSystemMsg } as unknown as ApiActionContext);

    const response = await handler.handle('get_group_system_msg', {
      group_id: '100000002',
      only_pending: true,
      count: '80',
    });

    expect(response.status).toBe('ok');
    expect(handleGetGroupSystemMsg).toHaveBeenCalledWith({
      groupId: 100000002,
      onlyPending: true,
      count: 80,
    });
    const doc = ACTION_REGISTRY.resolve('get_group_system_msg');
    if (!doc || doc.kind === 'raw') throw new Error('get_group_system_msg action missing');
    expect(doc.action.doc.params.map((param) => param.name)).toEqual(['group_id', 'only_pending', 'count']);
  });
});

describe('ActionRegistry.bind', () => {
  function testRegistry(...specs: RegisteredActionSpec[]) {
    return compileActionRegistry(groups(...specs), RAW_ACTION_RESERVATIONS);
  }

  it('binds only names declared by the injected complete registry', async () => {
    const api = new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(normal('__registry_normal__')),
    );
    expect((await api.handle('__registry_normal__', {})).status).toBe('ok');
    expect(api.isStreamAction('__registry_normal__')).toBe(false);
    expect((await api.handle('__rogue__', {})).retcode).toBe(1404);
  });

  it('keeps stream classification bound to the sealed compiled claim', () => {
    const api = new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(stream('__registry_stream__')),
    );
    expect(api.isStreamAction('__registry_stream__')).toBe(true);
    expect(api.isStreamAction('__registry_normal__')).toBe(false);
  });

  it('rejects a missing raw factory for a reserved name', () => {
    const registry = testRegistry(normal('declared'));
    expect(() => registry.bind({} as ApiActionContext, {} as ApiHandler, {})).toThrow(
      /raw factory missing.*handle_quick_operation.*kind raw/,
    );
  });

  it('rejects an unexpected raw factory', () => {
    const registry = compileActionRegistry(groups(normal('declared')));
    expect(() => registry.bind({} as ApiActionContext, {} as ApiHandler, {
      extra: () => async () => okResponse(),
    })).toThrow(/unexpected raw factory.*extra.*kind raw/);
  });

  it('constructs an injected registry that has no raw reservation', async () => {
    const api = new ApiHandler(
      {} as ApiActionContext,
      undefined,
      compileActionRegistry(groups(normal('declared'))),
    );
    expect((await api.handle('declared', {})).status).toBe('ok');
    expect((await api.handle(HANDLE_QUICK_OPERATION_ACTION, {})).retcode).toBe(1404);
  });
});
