// Shared fixtures for the per-theme bridge-action tests.
//
// Each action test file mocks `../src/bridge/bridge-oidb` and (where
// needed) `../src/bridge/highway/*` so we can assert what the action
// asked the OIDB / Highway layer to do without booting a real Bridge.
//
// `mockBridge()` returns a minimal stand-in: enough state for the
// actions to thread but no real packet/event machinery.
//
// As the #6 Api-on-ctx refactor moves business methods OFF Bridge and
// onto `bridge.apis.<area>.method()`, the mock grows an `apis` block
// matching the ApiHub shape. Each Api gets its own stub helper
// (e.g. `mockMessageApi()`) and tests can override individual entries
// via `mockBridge({ apis: { message: ... } })`.

import { vi } from 'vitest';
import type { SendPacketResult } from '../../src/protocol/packet-sender';

/** Default receipt returned by sendGroup / sendPrivate / sendC2cFile mocks. */
const STUB_RECEIPT = { messageId: 1, sequence: 1, clientSequence: 0, random: 1, timestamp: 0 };

export interface MockMessageApi {
  sendGroup: ReturnType<typeof vi.fn>;
  sendPrivate: ReturnType<typeof vi.fn>;
  sendC2cFile: ReturnType<typeof vi.fn>;
  recallGroup: ReturnType<typeof vi.fn>;
  recallPrivate: ReturnType<typeof vi.fn>;
  markGroupRead: ReturnType<typeof vi.fn>;
  markPrivateRead: ReturnType<typeof vi.fn>;
}

export function mockMessageApi(): MockMessageApi {
  return {
    sendGroup: vi.fn(async () => STUB_RECEIPT),
    sendPrivate: vi.fn(async () => STUB_RECEIPT),
    sendC2cFile: vi.fn(async () => STUB_RECEIPT),
    recallGroup: vi.fn(async () => undefined),
    recallPrivate: vi.fn(async () => undefined),
    markGroupRead: vi.fn(async () => undefined),
    markPrivateRead: vi.fn(async () => undefined),
  };
}

export interface MockApiHub {
  message: MockMessageApi;
  // additional Apis added commit-by-commit as #6 progresses
}

export function mockApiHub(overrides: Partial<MockApiHub> = {}): MockApiHub {
  return {
    message: overrides.message ?? mockMessageApi(),
  };
}

export interface MockBridge {
  identity: {
    uin: string;
    selfUid: string;
    nickname: string;
    findUidByUin: ReturnType<typeof vi.fn>;
    findUinByUid: ReturnType<typeof vi.fn>;
    findGroupMember: ReturnType<typeof vi.fn>;
  };
  apis: MockApiHub;
  sendRawPacket: ReturnType<typeof vi.fn>;
  fetchFriendList: ReturnType<typeof vi.fn>;
  fetchGroupMemberList: ReturnType<typeof vi.fn>;
  fetchUserProfile: ReturnType<typeof vi.fn>;
  resolveUserUid: ReturnType<typeof vi.fn>;
  sendGroupFileMessage: ReturnType<typeof vi.fn>;
  // Uploaded-file metadata cache helpers — actions like uploadGroupFile
  // / uploadPrivateFile call these to remember the upload, so tests
  // covering those code paths get a default-no-op shim.
  rememberUploadedFile: ReturnType<typeof vi.fn>;
  recallUploadedFile: ReturnType<typeof vi.fn>;
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
    apis: overrides.apis ?? mockApiHub(),
    sendRawPacket: vi.fn(async () => defaultResp),
    fetchFriendList: vi.fn(async () => []),
    fetchGroupMemberList: vi.fn(async () => []),
    fetchUserProfile: vi.fn(async () => ({ uid: 'profile-uid' })),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
    sendGroupFileMessage: vi.fn(async () => undefined),
    rememberUploadedFile: vi.fn(),
    recallUploadedFile: vi.fn(() => undefined),
    ...overrides,
  };
}
