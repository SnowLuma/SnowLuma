// 0xF90 — group todo (群待办) CRUD.
//   subCommand 1 = set, 2 = complete, 3 = cancel
//
// All three sub-cmds share the same request shape ((groupUin, msgSeq))
// so they collapse into one namespace with a dynamic subcmd resolver.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbGroupTodo } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export type GroupTodoAction = 'set' | 'complete' | 'cancel';

const ACTION_TO_SUBCMD: Record<GroupTodoAction, number> = {
  set: 1,
  complete: 2,
  cancel: 3,
};

export namespace GroupTodo {
  export const command = 0xF90;

  export interface Params {
    groupId: number;
    msgSeq: bigint;
    action: GroupTodoAction;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => ACTION_TO_SUBCMD[p.action];

  export const serialize = (p: Params): OidbGroupTodo => ({
    groupUin: p.groupId,
    msgSeq: p.msgSeq,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbGroupTodo>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupTodo>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, GroupTodo, params);
}
