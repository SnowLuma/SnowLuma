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
import type { SendPacketResult } from '@snowluma/common/packet-sender';

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

export interface MockContactsApi {
  fetchFriendList: ReturnType<typeof vi.fn>;
  fetchGroupList: ReturnType<typeof vi.fn>;
  fetchGroupMemberList: ReturnType<typeof vi.fn>;
  fetchUserProfile: ReturnType<typeof vi.fn>;
  fetchGroupRequests: ReturnType<typeof vi.fn>;
  fetchDownloadRKeys: ReturnType<typeof vi.fn>;
}

export function mockContactsApi(): MockContactsApi {
  return {
    fetchFriendList: vi.fn(async () => []),
    fetchGroupList: vi.fn(async () => []),
    fetchGroupMemberList: vi.fn(async () => []),
    fetchUserProfile: vi.fn(async () => ({ uid: 'profile-uid' })),
    fetchGroupRequests: vi.fn(async () => []),
    fetchDownloadRKeys: vi.fn(async () => []),
  };
}

export interface MockGroupFileApi {
  upload: ReturnType<typeof vi.fn>;
  uploadPrivate: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  getCount: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getUrl: ReturnType<typeof vi.fn>;
  getPrivateUrl: ReturnType<typeof vi.fn>;
  getPttUrl: ReturnType<typeof vi.fn>;
  getPrivatePttUrl: ReturnType<typeof vi.fn>;
  getVideoUrl: ReturnType<typeof vi.fn>;
  getPrivateVideoUrl: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  createFolder: ReturnType<typeof vi.fn>;
  deleteFolder: ReturnType<typeof vi.fn>;
  renameFolder: ReturnType<typeof vi.fn>;
}

export function mockGroupFileApi(): MockGroupFileApi {
  return {
    upload: vi.fn(async () => ({ fileId: 'stub-fid' })),
    uploadPrivate: vi.fn(async () => ({ fileId: 'stub-pfid', fileHash: 'stub-hash' })),
    publish: vi.fn(async () => undefined),
    getCount: vi.fn(async () => ({ fileCount: 0, maxCount: 10000 })),
    list: vi.fn(async () => ({ files: [], folders: [] })),
    getUrl: vi.fn(async () => 'stub://url'),
    getPrivateUrl: vi.fn(async () => 'stub://private-url'),
    getPttUrl: vi.fn(async () => 'stub://ptt-url'),
    getPrivatePttUrl: vi.fn(async () => 'stub://private-ptt-url'),
    getVideoUrl: vi.fn(async () => 'stub://video-url'),
    getPrivateVideoUrl: vi.fn(async () => 'stub://private-video-url'),
    delete: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    createFolder: vi.fn(async () => undefined),
    deleteFolder: vi.fn(async () => undefined),
    renameFolder: vi.fn(async () => undefined),
  };
}

export interface MockApiHub {
  message: MockMessageApi;
  contacts: MockContactsApi;
  groupFile: MockGroupFileApi;
  // additional Apis added commit-by-commit as #6 progresses
}

export function mockApiHub(overrides: Partial<MockApiHub> = {}): MockApiHub {
  return {
    message: overrides.message ?? mockMessageApi(),
    contacts: overrides.contacts ?? mockContactsApi(),
    groupFile: overrides.groupFile ?? mockGroupFileApi(),
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
    forgetGroup: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  apis: MockApiHub;
  sendRawPacket: ReturnType<typeof vi.fn>;
  fetchFriendList: ReturnType<typeof vi.fn>;
  fetchGroupMemberList: ReturnType<typeof vi.fn>;
  fetchUserProfile: ReturnType<typeof vi.fn>;
  resolveUserUid: ReturnType<typeof vi.fn>;
  // Uploaded-file metadata cache helpers — GroupFileApi.upload /
  // uploadPrivate call these to remember the upload, so tests
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
      forgetGroup: vi.fn(),
      ...(overrides.identity ?? {}),
    } as MockBridge['identity'],
    events: overrides.events ?? { emit: vi.fn(async () => undefined) },
    apis: overrides.apis ?? mockApiHub(),
    sendRawPacket: vi.fn(async () => defaultResp),
    fetchFriendList: vi.fn(async () => []),
    fetchGroupMemberList: vi.fn(async () => []),
    fetchUserProfile: vi.fn(async () => ({ uid: 'profile-uid' })),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
    rememberUploadedFile: vi.fn(),
    recallUploadedFile: vi.fn(() => undefined),
    ...overrides,
  };
}
