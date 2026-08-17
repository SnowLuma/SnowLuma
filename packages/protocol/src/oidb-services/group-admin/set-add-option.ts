// 0x89A_0 — set group "how to join" option (anyone / verification /
// owner-only / etc). Same cmd+subcmd as MuteAll / SetSearch / SetName
// — disambiguated by the body proto shape.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x89a_0AddOption,
  Oidb0x89a_0AddOptionSettings,
} from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

/** Official join modes that carry a question. 55 is accepted as an alias of 5. */
export function isQuestionAddType(addType: number): boolean {
  return addType === 4 || addType === 5 || addType === 55;
}

export function wireAddType(addType: number): number {
  return addType === 55 ? 5 : addType;
}

export namespace SetAddOption {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    addType: number;
    groupQuestion?: string;
    groupAnswer?: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0AddOption => {
    const addType = wireAddType(p.addType);
    const settings: Oidb0x89a_0AddOptionSettings = { addType };
    if (isQuestionAddType(p.addType)) {
      settings.groupQuestion = p.groupQuestion ?? '';
      // Type 4 keeps the answer; type 5/55 is question-only and clears it.
      settings.groupAnswer = addType === 4 ? (p.groupAnswer ?? '') : '';
    }
    return { groupUin: BigInt(p.groupId), settings, field12: 0 };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0AddOption>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0AddOption>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetAddOption, params);
}
