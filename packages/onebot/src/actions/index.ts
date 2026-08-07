// Action registry — the single source of the executable OneBot namespace.
//
// ACTION_GROUPS is the authored input. ACTION_REGISTRY compiles it exactly
// once at module initialization, validating canonical names, aliases, stream
// classification, and the reserved raw-action namespace before any
// ApiHandler can start. Runtime registration and generated docs are projections
// of that same compiled value; neither is allowed to rebuild its own list.

import type { ActionDoc, RegisteredActionSpec } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { actions as infoActions } from './info';
import { actions as messageActions } from './message';
import { actions as friendActions } from './friend';
import { actions as groupInfoActions } from './group-info';
import { actions as groupAdminActions } from './group-admin';
import { actions as groupFileActions } from './group-file';
import { actions as requestActions } from './request';
import { actions as extendedActions } from './extended';
import { actions as groupAlbumActions } from './group-album';
import { actions as qzoneActions } from './qzone';
import { actions as streamFileActions } from './stream-file';
import { actions as streamDownloadActions } from './stream-download';
import { actions as systemFaceActions } from './system-face';

export interface ActionGroup {
  /** Domain category (= source file), surfaced to the MCP / UI for grouping. */
  readonly category: string;
  readonly actions: readonly RegisteredActionSpec[];
}

export interface RawActionReservation {
  /** Executable wire name reserved for a handler that cannot be an ActionSpec. */
  readonly name: string;
  /** Diagnostic owner. Usually identical to name; explicit for conflict logs. */
  readonly canonical: string;
}

export type CompiledActionKind = RegisteredActionSpec['kind'] | 'raw';
export type ActionNameRole = 'canonical' | 'alias' | 'raw';

export interface CompiledAction {
  readonly canonical: string;
  readonly names: readonly string[];
  readonly kind: RegisteredActionSpec['kind'];
  readonly category: string;
  readonly doc: ActionDoc;
  readonly spec: RegisteredActionSpec;
}

interface ActionNameClaimBase {
  readonly name: string;
  readonly canonical: string;
  readonly kind: CompiledActionKind;
  readonly role: ActionNameRole;
}

export interface CompiledDeclarativeName extends ActionNameClaimBase {
  readonly kind: RegisteredActionSpec['kind'];
  readonly role: 'canonical' | 'alias';
  readonly action: CompiledAction;
}

export interface CompiledRawName extends ActionNameClaimBase {
  readonly kind: 'raw';
  readonly role: 'raw';
}

export type CompiledActionName = CompiledDeclarativeName | CompiledRawName;

export interface CompiledActionRegistry {
  /** Canonical declarative actions in authored group/action order. */
  readonly actions: readonly CompiledAction[];
  /** Every executable name, including aliases and reserved raw handlers. */
  readonly executableNames: readonly CompiledActionName[];
  /** Category order/counts used by the docs and UI. */
  readonly categories: readonly { category: string; count: number }[];
  readonly rawActions: readonly CompiledRawName[];
  resolve(name: string): CompiledActionName | undefined;
  register(h: ApiHandler, ctx: ApiActionContext): void;
}

function validateSpecProjection(spec: RegisteredActionSpec, doc: ActionDoc): void {
  const canonical = spec.names[0];
  if (!canonical || canonical.trim() === '') {
    throw new Error(`Action registry invalid ${spec.kind} action: canonical name must not be empty`);
  }
  for (const name of spec.names) {
    if (name.trim() === '') {
      throw new Error(`Action registry invalid ${spec.kind} action canonical "${canonical}": executable name must not be empty`);
    }
  }

  const aliases = spec.names.slice(1);
  if (doc.name !== canonical || doc.aliases.length !== aliases.length || doc.aliases.some((name, i) => name !== aliases[i])) {
    throw new Error(
      `Action registry invalid ${spec.kind} action canonical "${canonical}": describe() names do not match executable names`,
    );
  }
  const documentedKind = doc.stream === true ? 'stream' : 'normal';
  if (documentedKind !== spec.kind) {
    throw new Error(
      `Action registry invalid ${spec.kind} action canonical "${canonical}": describe() reports kind ${documentedKind}`,
    );
  }
}

function conflictMessage(name: string, first: CompiledActionName, second: CompiledActionName): string {
  return [
    `Action registry conflict for executable name "${name}"`,
    `canonical "${first.canonical}" (name "${first.name}", kind ${first.kind}, role ${first.role})`,
    `canonical "${second.canonical}" (name "${second.name}", kind ${second.kind}, role ${second.role})`,
  ].join(': ');
}

/** Compile and validate a complete executable namespace. Exported so the
 *  conflict matrix can be tested without constructing an ApiHandler. */
export function compileActionRegistry(
  groups: readonly ActionGroup[],
  rawReservations: readonly RawActionReservation[] = [],
): CompiledActionRegistry {
  const actions: CompiledAction[] = [];
  const executableNames: CompiledActionName[] = [];
  const rawActions: CompiledRawName[] = [];
  const byName = new Map<string, CompiledActionName>();

  const claim = (next: CompiledActionName): void => {
    const previous = byName.get(next.name);
    if (previous) throw new Error(conflictMessage(next.name, previous, next));
    byName.set(next.name, next);
    executableNames.push(next);
  };

  for (const group of groups) {
    for (const spec of group.actions) {
      const described = spec.describe();
      validateSpecProjection(spec, described);
      const canonical = spec.names[0]!;
      const action: CompiledAction = Object.freeze({
        canonical,
        names: Object.freeze([...spec.names]),
        kind: spec.kind,
        category: group.category,
        doc: Object.freeze({ ...described, category: group.category }),
        spec,
      });
      actions.push(action);
      action.names.forEach((name, index) => claim(Object.freeze({
        name,
        canonical,
        kind: action.kind,
        role: index === 0 ? 'canonical' : 'alias',
        action,
      })));
    }
  }

  for (const reservation of rawReservations) {
    if (reservation.name.trim() === '' || reservation.canonical.trim() === '') {
      throw new Error('Action registry invalid raw action: canonical and executable name must not be empty');
    }
    const raw: CompiledRawName = Object.freeze({
      name: reservation.name,
      canonical: reservation.canonical,
      kind: 'raw',
      role: 'raw',
    });
    claim(raw);
    rawActions.push(raw);
  }

  const categories = groups.map(({ category, actions: groupActions }) => Object.freeze({
    category,
    count: groupActions.length,
  }));

  return Object.freeze({
    actions: Object.freeze(actions),
    executableNames: Object.freeze(executableNames),
    categories: Object.freeze(categories),
    rawActions: Object.freeze(rawActions),
    resolve: (name: string) => byName.get(name),
    register: (h: ApiHandler, ctx: ApiActionContext) => {
      for (const action of actions) action.spec.register(h, ctx);
    },
  });
}

/** Every declarative action, grouped by domain category. Authored input. */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  { category: '信息', actions: infoActions },
  { category: '消息', actions: messageActions },
  { category: '好友', actions: friendActions },
  { category: '群信息', actions: groupInfoActions },
  { category: '群管理', actions: groupAdminActions },
  { category: '群文件', actions: groupFileActions },
  { category: '请求', actions: requestActions },
  { category: '扩展', actions: extendedActions },
  { category: '群相册', actions: groupAlbumActions },
  { category: '空间', actions: qzoneActions },
  { category: '系统表情', actions: systemFaceActions },
  { category: '流式接口', actions: [...streamFileActions, ...streamDownloadActions] },
];

/** The sole non-ActionSpec handler; reserved in the same namespace up front. */
export const HANDLE_QUICK_OPERATION_ACTION = '.handle_quick_operation';
export const RAW_ACTION_RESERVATIONS: readonly RawActionReservation[] = [
  { name: HANDLE_QUICK_OPERATION_ACTION, canonical: HANDLE_QUICK_OPERATION_ACTION },
];

/** Complete, validated runtime/docs registry. Compilation happens on import. */
export const ACTION_REGISTRY = compileActionRegistry(ACTION_GROUPS, RAW_ACTION_RESERVATIONS);
