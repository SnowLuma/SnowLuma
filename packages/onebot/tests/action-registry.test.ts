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
  it('preserves all 180 canonical Action docs', () => {
    expect(ACTION_REGISTRY.actions).toHaveLength(180);
    expect(collectActionDocs()).toHaveLength(180);
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

  it('registers the exact compiled executable-name/kind projection at runtime', () => {
    const registered: Array<[string, 'normal' | 'stream']> = [];
    const fakeHandler = {
      registerAction: (name: string) => { registered.push([name, 'normal']); },
      registerStreamAction: (name: string) => { registered.push([name, 'stream']); },
    } as unknown as ApiHandler;

    ACTION_REGISTRY.register(fakeHandler, {} as ApiActionContext);

    expect(registered).toEqual(
      ACTION_REGISTRY.executableNames
        .filter((entry) => entry.kind !== 'raw')
        .map((entry) => [entry.name, entry.kind]),
    );
  });

  it('validates and forwards get_group_system_msg filters', async () => {
    const handleGetGroupSystemMsg = vi.fn(async () => []);
    const handler = new ApiHandler({ handleGetGroupSystemMsg } as unknown as ApiActionContext);

    const response = await handler.handle('get_group_system_msg', {
      group_id: '100000002',
      only_pending: true,
    });

    expect(response.status).toBe('ok');
    expect(handleGetGroupSystemMsg).toHaveBeenCalledWith({
      groupId: 100000002,
      onlyPending: true,
    });
    const doc = ACTION_REGISTRY.resolve('get_group_system_msg');
    if (!doc || doc.kind === 'raw') throw new Error('get_group_system_msg action missing');
    expect(doc.action.doc.params.map((param) => param.name)).toEqual(['group_id', 'only_pending']);
  });
});

describe('ApiHandler constructor-time registry transaction', () => {
  const handler = async () => okResponse();

  function testRegistry(...specs: RegisteredActionSpec[]) {
    return compileActionRegistry(groups(...specs), RAW_ACTION_RESERVATIONS);
  }

  function withRegistration(
    base: RegisteredActionSpec,
    register: RegisteredActionSpec['register'],
  ): RegisteredActionSpec {
    return { kind: base.kind, names: base.names, describe: base.describe, register };
  }

  it('binds only names declared by the injected complete registry, then seals', async () => {
    const api = new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(normal('__registry_normal__')),
    );
    expect((await api.handle('__registry_normal__', {})).status).toBe('ok');
    expect(api.isStreamAction('__registry_normal__')).toBe(false);
    expect(() => api.registerAction('__rogue__', handler)).toThrow(/Action registry is sealed/);
    expect((await api.handle('__rogue__', {})).retcode).toBe(1404);
  });

  it('keeps stream classification bound to the sealed compiled claim', () => {
    const api = new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(stream('__registry_stream__')),
    );
    expect(() => api.registerAction('__registry_stream__', handler)).toThrow(
      /Action registry is sealed/,
    );
    expect(api.isStreamAction('__registry_stream__')).toBe(true);
  });

  it('rejects a spec that registers an undeclared executable name', () => {
    const base = normal('declared');
    const malicious = withRegistration(base, (api) => api.registerAction('rogue', handler));
    expect(() => new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(malicious),
    )).toThrow(/not declared.*canonical "rogue".*name "rogue".*kind normal/);
  });

  it('rejects a spec whose registration kind disagrees with its compiled claim', () => {
    const base = normal('declared');
    const malicious = withRegistration(base, (api) => api.registerStreamAction('declared', handler));
    expect(() => new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(malicious),
    )).toThrow(/kind mismatch.*canonical "declared".*registry kind normal, registration kind stream/);
  });

  it('rejects duplicate constructor-time handler binding', () => {
    const base = normal('declared');
    const malicious = withRegistration(base, (api) => {
      api.registerAction('declared', handler);
      api.registerAction('declared', handler);
    });
    expect(() => new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(malicious),
    )).toThrow(/canonical "declared".*kind normal.*conflicts with.*canonical "declared".*kind normal/);
  });

  it('rejects a compiled claim that did not bind a handler', () => {
    const base = normal('declared');
    const malicious = withRegistration(base, () => {});
    expect(() => new ApiHandler(
      {} as ApiActionContext,
      undefined,
      testRegistry(malicious),
    )).toThrow(/claim has no handler.*canonical "declared".*name "declared".*kind normal/);
  });

  it('requires the raw quick-operation reservation in an injected registry', () => {
    const incomplete = compileActionRegistry(groups(normal('declared')));
    expect(() => new ApiHandler(
      {} as ApiActionContext,
      undefined,
      incomplete,
    )).toThrow(/not declared.*handle_quick_operation.*kind raw/);
  });
});
