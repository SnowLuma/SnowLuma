/** Official "my computer / my phone / my Pad" device contacts. */

export const DATALINE_SELF_TER_TYPE = 1;

export const DATALINE_TER_PC = 1;
export const DATALINE_TER_PHONE = 2;
export const DATALINE_TER_PAD = 3;

/** Stable OneBot user_ids reserved for the three official device peers. */
export const DATALINE_UIN_PC = 0x7E000001;
export const DATALINE_UIN_PHONE = 0x7E000002;
export const DATALINE_UIN_PAD = 0x7E000003;

export interface DatalineDeviceContact {
  readonly terType: number;
  readonly uid: string;
  readonly name: string;
  readonly uin: number;
}

export interface DatalineFriendEntry {
  user_id: number;
  nickname: string;
  remark: string;
}

export const DATALINE_DEVICES: readonly DatalineDeviceContact[] = [
  {
    terType: DATALINE_TER_PC,
    uid: 'u_rK7NMsbv2ZjEGPdCuOiCfw',
    name: '我的电脑',
    uin: DATALINE_UIN_PC,
  },
  {
    terType: DATALINE_TER_PHONE,
    uid: 'u_Wcc5rknRRqRO8y5gxMD6sA',
    name: '我的手机',
    uin: DATALINE_UIN_PHONE,
  },
  {
    terType: DATALINE_TER_PAD,
    uid: 'u_l7jpPIZxQo0mzJwoEt-SKw',
    name: '我的Pad',
    uin: DATALINE_UIN_PAD,
  },
];

const BY_UIN = new Map(DATALINE_DEVICES.map((device) => [device.uin, device]));
const BY_TER = new Map(DATALINE_DEVICES.map((device) => [device.terType, device]));

export function findDatalineDeviceByUin(uin: number): DatalineDeviceContact | undefined {
  return BY_UIN.get(uin);
}

export function findDatalineDeviceByTerType(terType: number): DatalineDeviceContact | undefined {
  return BY_TER.get(terType);
}

export function isDatalineDeviceUin(uin: number): boolean {
  return BY_UIN.has(uin);
}

export function datalineFriendListEntries(): DatalineFriendEntry[] {
  return DATALINE_DEVICES.map((device) => ({
    user_id: device.uin,
    nickname: device.name,
    remark: device.name,
  }));
}

export function appendDatalineFriendEntries<T extends { user_id: number }>(
  friends: readonly T[],
): Array<T | DatalineFriendEntry> {
  const occupied = new Set(friends.map((friend) => friend.user_id));
  const extras = datalineFriendListEntries().filter((entry) => !occupied.has(entry.user_id));
  return extras.length === 0 ? [...friends] : [...friends, ...extras];
}

export function appIdForTerType(terType: number): number {
  return terType === DATALINE_TER_PC ? 1 : 1001;
}
