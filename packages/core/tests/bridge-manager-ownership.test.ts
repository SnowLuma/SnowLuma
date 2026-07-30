import {
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';

const previousLogLevel = getLogLevel();

const OK_RESULT: SendPacketResult = {
  success: true,
  gotResponse: true,
  errorCode: 0,
  errorMessage: '',
  responseData: Buffer.alloc(0),
};

function makeSender() {
  const sendPacket = vi.fn<PacketSender['sendPacket']>(async () => OK_RESULT);
  return {
    client: { sendPacket } satisfies PacketSender,
    sendPacket,
  };
}

function packet(pid: number, uin: string): PacketInfo {
  return {
    pid,
    uin,
    serviceCmd: 'Test.Unhandled',
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body: Buffer.alloc(0),
  };
}

describe('BridgeManager PID ownership', () => {
  beforeEach(() => {
    vi.spyOn(IdentityService, 'openForUin')
      .mockImplementation((uin) => IdentityService.memory(uin));
  });

  afterEach(() => {
    setLogLevel(previousLogLevel);
    vi.restoreAllMocks();
  });

  it('records complete incoming packet bytes under one top-level TRACE request', async () => {
    const manager = new BridgeManager();
    const entries: LogEntry[] = [];
    const body = Buffer.from([
      0x00, 0xff, ...Array.from({ length: 160 }, (_, index) => (159 - index) & 0xff),
    ]);
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      manager.onPacket({
        pid: 101,
        uin: '10001',
        serviceCmd: 'Trace\nCommand',
        seqId: 987,
        retCode: -5,
        fromClient: true,
        body,
      });
      await new Promise((resolve) => setImmediate(resolve));

      const packetEntries = entries.filter((entry) =>
        entry.level === 'trace'
        && (entry.scope === 'Bridge.Packet' || entry.scope === 'Protocol.Packet'));
      expect(packetEntries).toHaveLength(3);
      expect(packetEntries.map((entry) => entry.req)).toEqual([
        expect.any(Number),
        packetEntries[0]!.req,
        packetEntries[0]!.req,
      ]);
      expect(packetEntries[0]!.message).toBe(
        `packet_push serviceCmd="Trace\\nCommand" seqId=987 retCode=-5 fromClient=true pid=101 uin="10001" length=${body.length} body=${body.toString('hex')}`,
      );
      expect(packetEntries[1]!.message).toBe(
        'packet_branch serviceCmd="Trace\\nCommand" seqId=987 branch=parser_unregistered',
      );
      expect(packetEntries[2]!.message).toMatch(
        /^packet_terminal serviceCmd="Trace\\nCommand" seqId=987 outcome=dropped reason=parser_unregistered events=0 dispatched=0 elapsedMs=\d+$/,
      );
      for (const entry of packetEntries) expect(entry.message).not.toContain('...');
    } finally {
      unsubscribe();
    }
  });

  it('records invalid UIN as a routed packet drop without creating a session', () => {
    const manager = new BridgeManager();
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      manager.onPacket({
        ...packet(101, '0'),
        body: Buffer.from([0x00, 0xff]),
      });

      expect(entries.filter((entry) => entry.scope === 'Bridge.Packet'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            level: 'trace',
            req: expect.any(Number),
            message: 'packet_push serviceCmd="Test.Unhandled" seqId=1 retCode=0 fromClient=false pid=101 uin="0" length=2 body=00ff',
          }),
          expect.objectContaining({
            level: 'trace',
            req: expect.any(Number),
            message: expect.stringMatching(/^packet_terminal serviceCmd="Test\.Unhandled" seqId=1 outcome=dropped reason=invalid_uin events=0 dispatched=0 elapsedMs=\d+$/),
          }),
        ]));
      expect(manager.getSession('0')).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  it('assigns distinct request ids to independent incoming packets', () => {
    const manager = new BridgeManager();
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      manager.onPacket(packet(101, '0'));
      manager.onPacket(packet(202, '0'));

      const packetEntries = entries.filter((entry) =>
        entry.level === 'trace'
        && entry.scope === 'Bridge.Packet');
      expect(packetEntries).toHaveLength(4);
      expect(packetEntries[0]!.req).toEqual(expect.any(Number));
      expect(packetEntries[1]!.req).toBe(packetEntries[0]!.req);
      expect(packetEntries[2]!.req).toEqual(expect.any(Number));
      expect(packetEntries[3]!.req).toBe(packetEntries[2]!.req);
      expect(packetEntries[2]!.req).not.toBe(packetEntries[0]!.req);
    } finally {
      unsubscribe();
    }
  });

  it('does not render incoming packet bytes or allocate request IDs while TRACE is disabled', () => {
    const manager = new BridgeManager();
    const entries: LogEntry[] = [];
    setLogLevel('debug');
    const hex = vi.spyOn(Buffer.prototype, 'toString');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      manager.onPacket({
        ...packet(0, '10001'),
        body: Buffer.from([0x00, 0xff]),
      });

      expect(hex).not.toHaveBeenCalledWith('hex');
      expect(entries.some((entry) => entry.req !== undefined)).toBe(false);
    } finally {
      unsubscribe();
      hex.mockRestore();
    }
  });

  it('detaches a PID from its old UIN before starting its replacement session', () => {
    const manager = new BridgeManager();
    const first = makeSender();
    const second = makeSender();
    const lifecycle: string[] = [];
    manager.addSessionStartedListener((uin) => lifecycle.push(`started:${uin}`));
    manager.addSessionClosedListener((uin) => lifecycle.push(`closed:${uin}`));

    manager.onHookLogin(101, '10001', first.client);
    const oldBridge = manager.getSession('10001')!.bridge;
    const dispose = vi.spyOn(oldBridge, 'dispose');

    manager.onHookLogin(101, '20002', second.client);

    expect(lifecycle).toEqual([
      'started:10001',
      'closed:10001',
      'started:20002',
    ]);
    expect(manager.getSession('10001')).toBeNull();
    expect(oldBridge.hasPid(101)).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getSession('20002')!.bridge.hasPid(101)).toBe(true);
  });

  it('keeps a multi-PID UIN alive and falls back to the remaining sender', async () => {
    const manager = new BridgeManager();
    const first = makeSender();
    const second = makeSender();
    const closed = vi.fn();
    manager.addSessionClosedListener(closed);

    manager.onHookLogin(101, '10001', first.client);
    manager.onHookLogin(202, '10001', second.client);
    const bridge = manager.getSession('10001')!.bridge;

    expect(bridge.activePid).toBe(202);
    await bridge.sendRawPacket('Test.BeforeDisconnect', new Uint8Array([1]));
    expect(second.sendPacket).toHaveBeenCalledOnce();
    expect(first.sendPacket).not.toHaveBeenCalled();

    manager.onPidDisconnected(202);

    expect(manager.getSession('10001')!.bridge).toBe(bridge);
    expect(bridge.activePid).toBe(101);
    expect(closed).not.toHaveBeenCalled();
    await bridge.sendRawPacket('Test.AfterDisconnect', new Uint8Array([2]));
    expect(first.sendPacket).toHaveBeenCalledOnce();
    expect(second.sendPacket).toHaveBeenCalledOnce();

    manager.onPidDisconnected(101);
    expect(manager.getSession('10001')).toBeNull();
    expect(closed).toHaveBeenCalledOnce();
    await expect(bridge.sendRawPacket('Test.NoSender', new Uint8Array([3])))
      .resolves.toMatchObject({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'no packet sender attached',
      });
  });

  it('reports an account healthy while any attached PID still receives packets', () => {
    const manager = new BridgeManager();
    manager.onHookLogin(101, '10001', makeSender().client);
    manager.onHookLogin(202, '10001', makeSender().client);
    const bridge = manager.getSession('10001')!.bridge;

    expect(bridge.receiveHealthy).toBe(true);

    manager.onPidReceiveHealthChanged(101, false);
    expect(bridge.receiveHealthy).toBe(true);

    manager.onPidReceiveHealthChanged(202, false);
    expect(bridge.receiveHealthy).toBe(false);

    manager.onPidReceiveHealthChanged(101, true);
    expect(bridge.receiveHealthy).toBe(true);
  });

  it('prefers the most recently rebound live PID, then falls back by recency', async () => {
    const manager = new BridgeManager();
    const first = makeSender();
    const second = makeSender();
    const third = makeSender();
    const reboundFirst = makeSender();
    const started = vi.fn();
    manager.addSessionStartedListener(started);

    manager.onHookLogin(101, '10001', first.client);
    manager.onHookLogin(202, '10001', second.client);
    manager.onHookLogin(303, '10001', third.client);
    manager.onHookLogin(101, '10001', reboundFirst.client);
    const bridge = manager.getSession('10001')!.bridge;

    expect(started).toHaveBeenCalledOnce();
    expect(bridge.activePid).toBe(101);
    await bridge.sendRawPacket('Test.Rebound', new Uint8Array([1]));
    expect(reboundFirst.sendPacket).toHaveBeenCalledOnce();

    manager.onPidDisconnected(101);
    expect(bridge.activePid).toBe(303);
    await bridge.sendRawPacket('Test.Fallback', new Uint8Array([2]));
    expect(third.sendPacket).toHaveBeenCalledOnce();

    manager.onPidDisconnected(303);
    expect(bridge.activePid).toBe(202);
    await bridge.sendRawPacket('Test.SecondFallback', new Uint8Array([3]));
    expect(second.sendPacket).toHaveBeenCalledOnce();
  });

  it('applies the same ownership transition when a packet reveals a new UIN', async () => {
    const manager = new BridgeManager();
    const sender = makeSender();
    const lifecycle: string[] = [];
    manager.addSessionStartedListener((uin) => lifecycle.push(`started:${uin}`));
    manager.addSessionClosedListener((uin) => lifecycle.push(`closed:${uin}`));

    manager.onHookLogin(101, '10001', sender.client);
    manager.onPacket(packet(101, '20002'));

    expect(lifecycle).toEqual([
      'started:10001',
      'closed:10001',
      'started:20002',
    ]);
    expect(manager.getSession('10001')).toBeNull();
    const replacement = manager.getSession('20002')!.bridge;
    expect(replacement.hasPid(101)).toBe(true);
    await replacement.sendRawPacket('Test.AfterPacketRebind', new Uint8Array([1]));
    expect(sender.sendPacket).toHaveBeenCalledOnce();
  });

  it('keeps the old UIN alive when its active PID moves and a fallback remains', async () => {
    const manager = new BridgeManager();
    const fallback = makeSender();
    const moving = makeSender();
    const rebound = makeSender();
    const lifecycle: string[] = [];
    manager.addSessionStartedListener((uin) => lifecycle.push(`started:${uin}`));
    manager.addSessionClosedListener((uin) => lifecycle.push(`closed:${uin}`));

    manager.onHookLogin(101, '10001', fallback.client);
    manager.onHookLogin(202, '10001', moving.client);
    const oldBridge = manager.getSession('10001')!.bridge;
    expect(oldBridge.activePid).toBe(202);

    manager.onHookLogin(202, '20002', rebound.client);

    expect(lifecycle).toEqual(['started:10001', 'started:20002']);
    expect(manager.getSession('10001')!.bridge).toBe(oldBridge);
    expect(oldBridge.hasPid(202)).toBe(false);
    expect(oldBridge.activePid).toBe(101);
    await oldBridge.sendRawPacket('Test.OldUinFallback', new Uint8Array([1]));
    expect(fallback.sendPacket).toHaveBeenCalledOnce();

    const newBridge = manager.getSession('20002')!.bridge;
    expect(newBridge.activePid).toBe(202);
    await newBridge.sendRawPacket('Test.NewUinSender', new Uint8Array([2]));
    expect(rebound.sendPacket).toHaveBeenCalledOnce();

    manager.onPidDisconnected(202);
    expect(lifecycle).toEqual([
      'started:10001',
      'started:20002',
      'closed:20002',
    ]);
    manager.onPidDisconnected(101);
    expect(lifecycle).toEqual([
      'started:10001',
      'started:20002',
      'closed:20002',
      'closed:10001',
    ]);
  });

  it('does not emit another started edge when a PID joins an existing UIN', async () => {
    const manager = new BridgeManager();
    const first = makeSender();
    const second = makeSender();
    const reboundFirst = makeSender();
    const started = vi.fn();
    const closed = vi.fn();
    manager.addSessionStartedListener(started);
    manager.addSessionClosedListener(closed);

    manager.onHookLogin(101, '10001', first.client);
    manager.onHookLogin(202, '20002', second.client);
    const targetBridge = manager.getSession('20002')!.bridge;

    manager.onHookLogin(101, '20002', reboundFirst.client);

    expect(started).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith('10001', expect.anything());
    expect(manager.getSession('10001')).toBeNull();
    expect(manager.getSession('20002')!.bridge).toBe(targetBridge);
    expect(targetBridge.activePid).toBe(101);

    manager.onPidDisconnected(101);
    expect(targetBridge.activePid).toBe(202);
    await targetBridge.sendRawPacket('Test.ExistingTargetFallback', new Uint8Array([1]));
    expect(second.sendPacket).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();

    manager.onPidDisconnected(202);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('emits exactly one started/closed pair per real lifecycle', () => {
    const manager = new BridgeManager();
    const sender = makeSender();
    const started = vi.fn();
    const closed = vi.fn();
    manager.addSessionStartedListener(started);
    manager.addSessionClosedListener(closed);

    manager.onHookLogin(101, '10001', sender.client);
    manager.onHookLogin(101, '10001', sender.client);
    manager.onPacket(packet(101, '10001'));
    manager.onPacket(packet(101, '10001'));

    expect(started).toHaveBeenCalledOnce();
    manager.onPidDisconnected(101);
    manager.onPidDisconnected(101);
    expect(closed).toHaveBeenCalledOnce();

    manager.onHookLogin(101, '10001', sender.client);
    manager.onPidDisconnected(101);
    expect(started).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('fails fast with a routing terminal when Manager ownership has no sender', () => {
    const manager = new BridgeManager();
    const sender = makeSender();
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      manager.onHookLogin(101, '10001', sender.client);

      // Deliberately violate the private ownership invariant through Bridge's
      // compatibility surface: Manager still maps PID 101 to this UIN, while
      // Bridge no longer owns either the PID or its sender.
      manager.getSession('10001')!.bridge.detachPid(101);

      expect(() => manager.onPacket(packet(101, '10001'))).toThrowError(
        'BridgeManager invariant violated: PID=101 has no sender in UIN=10001 session',
      );
      const packetEntries = entries.filter((entry) =>
        entry.level === 'trace'
        && entry.scope === 'Bridge.Packet');
      expect(packetEntries).toHaveLength(2);
      expect(packetEntries[0]!.req).toEqual(expect.any(Number));
      expect(packetEntries[1]).toMatchObject({
        req: packetEntries[0]!.req,
        message: expect.stringMatching(/^packet_terminal serviceCmd="Test\.Unhandled" seqId=1 outcome=failed reason=routing_failed error="BridgeManager invariant violated: PID=101 has no sender in UIN=10001 session" events=0 dispatched=0 elapsedMs=\d+$/),
      });
      expect(() => manager.onPidDisconnected(101)).toThrowError(
        'BridgeManager invariant violated: PID=101 is mapped to UIN=10001, but Bridge does not own the PID',
      );
    } finally {
      unsubscribe();
    }
  });
});
