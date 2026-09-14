import { describe, expect, it } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { OnlineDeviceInfo, QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from '../src/bridge/bridge';

function packet(sequence: number): PacketInfo {
  return {
    pid: 1,
    uin: '10001',
    serviceCmd: 'test.online_devices',
    seqId: sequence,
    retCode: 0,
    fromClient: false,
    body: new Uint8Array(0),
  };
}

function device(overrides: Partial<OnlineDeviceInfo> = {}): OnlineDeviceInfo {
  return {
    appId: 537242075,
    instanceId: 202,
    clientType: 1,
    platform: 3,
    deviceName: 'DESKTOP-TEST',
    deviceKind: 'computer',
    ...overrides,
  };
}

describe('Bridge online-device snapshot', () => {
  it('distinguishes not-yet-observed from an observed empty snapshot', () => {
    const bridge = new Bridge(IdentityService.memory('10001'));
    let current: OnlineDeviceInfo[] = [device()];
    bridge.registerCmd('test.online_devices', () => [{
      kind: 'online_devices_changed',
      time: 1710000000,
      selfUin: 10001,
      devices: current,
    } satisfies QQEventVariant]);

    expect(bridge.getOnlineClients()).toBeNull();

    bridge.onPacket(packet(1));
    expect(bridge.getOnlineClients()).toEqual([device()]);

    current = [];
    bridge.onPacket(packet(2));
    expect(bridge.getOnlineClients()).toEqual([]);
  });

  it('owns an immutable copy and clears it when the Bridge is disposed', () => {
    const bridge = new Bridge(IdentityService.memory('10001'));
    const source = device();
    bridge.registerCmd('test.online_devices', () => [{
      kind: 'online_devices_changed',
      time: 1710000000,
      selfUin: 10001,
      devices: [source],
    }]);

    bridge.onPacket(packet(1));
    const snapshot = bridge.getOnlineClients();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.[0]).not.toBe(source);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.[0])).toBe(true);

    source.deviceName = 'MUTATED';
    expect(bridge.getOnlineClients()?.[0]?.deviceName).toBe('DESKTOP-TEST');

    bridge.dispose();
    expect(bridge.getOnlineClients()).toBeNull();
  });
});
