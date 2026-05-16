// Shared fixtures for the per-theme bridge-action tests.
//
// Each action test file mocks `../src/bridge/bridge-oidb` and (where
// needed) `../src/bridge/highway/*` so we can assert what the action
// asked the OIDB / Highway layer to do without booting a real Bridge.
//
// `mockBridge()` returns a minimal stand-in: enough state for the
// actions to thread but no real packet/event machinery.

import { vi } from 'vitest';
import type { SendPacketResult } from '../../src/protocol/packet-sender';

export interface MockBridge {
  identity: {
    uin: string;
    selfUid: string;
    nickname: string;
    findUidByUin: ReturnType<typeof vi.fn>;
    findUinByUid: ReturnType<typeof vi.fn>;
    findGroupMember: ReturnType<typeof vi.fn>;
  };
  sendRawPacket: ReturnType<typeof vi.fn>;
  fetchFriendList: ReturnType<typeof vi.fn>;
  fetchGroupMemberList: ReturnType<typeof vi.fn>;
  fetchUserProfile: ReturnType<typeof vi.fn>;
  resolveUserUid: ReturnType<typeof vi.fn>;
}

export function mockBridge(overrides: Partial<MockBridge> = {}): MockBridge {
  const defaultResp: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return {
    identity: {
      uin: '10001',
      selfUid: 'self-uid',
      nickname: 'self-nick',
      findUidByUin: vi.fn(() => 'cached-uid'),
      findUinByUid: vi.fn(() => 0),
      findGroupMember: vi.fn(() => null),
      ...(overrides.identity ?? {}),
    } as MockBridge['identity'],
    sendRawPacket: vi.fn(async () => defaultResp),
    fetchFriendList: vi.fn(async () => []),
    fetchGroupMemberList: vi.fn(async () => []),
    fetchUserProfile: vi.fn(async () => ({ uid: 'profile-uid' })),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
    ...overrides,
  };
}
