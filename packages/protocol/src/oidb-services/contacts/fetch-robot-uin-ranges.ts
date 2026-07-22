// 0x496_0 — fetch QQ's server-versioned robot UIN ranges.
//
// The 0xFE7_3 group-member response has no robot flag. QQ's own renderer
// initializes its robot service with this read-only request and classifies
// non-buddy UINs against the returned inclusive ranges. Keeping the config
// dynamic avoids baking Tencent's current allocation into SnowLuma.

import type { OidbBase, OidbRobotUinRangeResponse } from '@snowluma/proto-defs/oidb';
import type { OidbRobotUinRangeRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface RobotUinRange {
  minUin: number;
  maxUin: number;
}

export interface RobotUinRangeSnapshot {
  version: number;
  ranges: RobotUinRange[];
}

function decodeUin(value: bigint | number | undefined, label: string): number {
  const decoded = Number(value ?? 0);
  if (!Number.isSafeInteger(decoded) || decoded <= 0 || decoded > 0xFFFF_FFFF) {
    throw new Error(`0x496_0 response has invalid ${label}: ${String(value)}`);
  }
  return decoded;
}

export namespace FetchRobotUinRanges {
  export const command = 0x496;
  export const subCommand = 0;

  export type Deps = OidbSender;

  export const serialize = (): OidbRobotUinRangeRequest => ({
    justFetchMsgConfig: 1,
    type: 1,
    version: 0,
    aioKeywordVersion: 0,
  });

  export const deserialize = (
    _ctx: Deps,
    body: OidbRobotUinRangeResponse,
  ): RobotUinRangeSnapshot => {
    const config = body.robotConfig;
    if (!config) {
      throw new Error('0x496_0 response missing robot range config');
    }

    if (config.version === undefined) {
      throw new Error('0x496_0 response missing robot range config version');
    }
    const version = Number(config.version);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`0x496_0 response has invalid config version: ${String(config.version)}`);
    }

    if (!config.ranges || config.ranges.length === 0) {
      throw new Error('0x496_0 response has no robot UIN ranges');
    }
    const ranges = config.ranges.map((range, index) => {
      const minUin = decodeUin(range.minUin, `range[${index}].minUin`);
      const maxUin = decodeUin(range.maxUin, `range[${index}].maxUin`);
      if (minUin > maxUin) {
        throw new Error(
          `0x496_0 response has inverted range[${index}]: ${minUin}-${maxUin}`,
        );
      }
      return { minUin, maxUin };
    });

    return { version, ranges };
  };

  export const encode = (env: OidbBase<OidbRobotUinRangeRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbRobotUinRangeRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbRobotUinRangeResponse> =>
    protobuf_decode<OidbBase<OidbRobotUinRangeResponse>>(bytes);

  export const invoke = (deps: Deps): Promise<RobotUinRangeSnapshot> =>
    invokeOidb(deps, FetchRobotUinRanges, undefined);
}
