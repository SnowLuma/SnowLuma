import { createLogger, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { GroupInviteEvent } from '@snowluma/protocol/events';
import {
  formatGroupRequestFlag,
  type GroupRequestInfo,
} from '@snowluma/protocol/qq-info';

const DEFAULT_INTERVAL_MS = 15_000;
const REQUEST_SCREEN_COUNT = 50;
const RECENT_EVENT_WINDOW_MS = 30_000;
const MAX_SEEN_FLAGS = 2_048;

export interface GroupRequestPollerOptions {
  intervalMs?: number;
  now?: () => number;
}

/**
 * Some group requests (notably invitations initiated through qun.qq.com) are
 * visible in QQ's system-notification list without producing the real-time
 * push consumed by SnowLuma's packet pipeline. Observe both request inboxes
 * and emit only newly seen, actionable records through the same typed event
 * bus as push-originated requests.
 */
export class GroupRequestPoller {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly seenFlags = new Map<string, true>();
  private readonly recentFingerprints = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledTask: Promise<void> | null = null;
  private scanInFlight: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;
  private lifecycleStarted = false;

  constructor(
    private readonly bridge: BridgeInterface,
    private readonly selfUin: number,
    options: GroupRequestPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error(`invalid group-request polling interval: ${this.intervalMs}`);
    }
    this.now = options.now ?? Date.now;
    this.log = createLogger('OneBot.GroupRequests').child({ uin: selfUin });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lifecycleStarted = true;
    this.unsubscribe = this.bridge.events.on('group_invite', (event) => {
      this.rememberObservedEvent(event);
    });
    this.scheduledTask = this.runScheduledPoll();
  }

  stop(): Promise<void> {
    if (!this.running) return this.scheduledTask ?? Promise.resolve();
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    return this.scheduledTask ?? Promise.resolve();
  }

  /**
   * Public deterministic seam used by diagnostics and tests. Concurrent calls
   * share one scan so a slow QQ response cannot create overlapping polling.
   */
  pollOnce(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    const scan = this.scan();
    this.scanInFlight = scan;
    void scan.finally(() => {
      if (this.scanInFlight === scan) this.scanInFlight = null;
    }).catch(() => undefined);
    return scan;
  }

  private async scan(): Promise<void> {
    const [main, filtered] = await Promise.all([
      this.bridge.apis.contacts.fetchGroupRequests(false, REQUEST_SCREEN_COUNT),
      this.bridge.apis.contacts.fetchGroupRequests(true, REQUEST_SCREEN_COUNT),
    ]);
    if (this.lifecycleStarted && !this.running) return;
    const discovered = [...main, ...filtered]
      .filter((request) => request.state === 1)
      .filter((request) => request.eventType === 1 || request.eventType === 2 || request.eventType === 22 || request.notifyType === 1 || request.notifyType === 7);

    const now = this.now();
    this.sweepRecentFingerprints(now);
    for (const request of discovered) {
      if (this.lifecycleStarted && !this.running) return;
      let event: GroupInviteEvent;
      try {
        event = this.toEvent(request);
      } catch (error) {
        this.log.error(
          'group request record rejected: group=%s sequence=%s subtype=%s reason=%s',
          String(request.groupId),
          String(request.sequence),
          request.eventType === 2 || request.eventType === 22 || request.notifyType === 2 ? 'invite' : 'add',
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }

      const fingerprint = eventFingerprint(event);
      if (this.seenFlags.has(event.flag)) continue;
      if ((this.recentFingerprints.get(fingerprint) ?? 0) > now - RECENT_EVENT_WINDOW_MS) {
        this.rememberFlag(event.flag);
        continue;
      }

      if (event.fromUin === 0) {
        this.log.warn(
          'group request sender could not be identified: group=%d sequence=%d subtype=%s',
          event.groupId,
          request.sequence,
          event.subType,
        );
      }

      // Mark before emission: handlers may synchronously trigger another list
      // read through a quick operation, which must not re-emit this request.
      this.rememberFlag(event.flag);
      this.recentFingerprints.set(fingerprint, now);
      this.log.info(
        'new group request discovered: group=%d sequence=%d subtype=%s filtered=%s',
        event.groupId,
        request.sequence,
        event.subType,
        request.filtered,
      );
      await this.bridge.events.emit(event);
    }
  }

  private toEvent(request: GroupRequestInfo): GroupInviteEvent {
    const isInvite = request.eventType === 2 || request.eventType === 22 || request.notifyType === 2;
    const subType = isInvite ? 'invite' : 'add';
    const fromUin = isInvite ? request.invitorUin : request.targetUin;
    const fromUid = isInvite ? request.invitorUid : request.targetUid;
    const inviteCardSequence = isInvite
      ? this.bridge.apis.contacts.getGroupInviteCardSequence?.(request.groupId)
      : undefined;
    if (!Number.isSafeInteger(request.sequence) || request.sequence <= 0) {
      throw new Error(`invalid group-request sequence: ${request.sequence}`);
    }
    if (!Number.isSafeInteger(request.groupId) || request.groupId <= 0) {
      throw new Error(`invalid group id on group request: ${request.groupId}`);
    }
    if (!Number.isSafeInteger(request.eventType) || request.eventType <= 0) {
      throw new Error(
        `group request has no operation type: group=${request.groupId} sequence=${request.sequence} eventType=${request.eventType ?? 0}`,
      );
    }
    if (!Number.isSafeInteger(fromUin) || fromUin < 0) {
      throw new Error(`invalid sender account on group request: ${fromUin}`);
    }
    if (inviteCardSequence !== undefined
      && (!Number.isSafeInteger(inviteCardSequence) || inviteCardSequence <= 0)) {
      throw new Error(
        `invalid invite-card sequence: group=${request.groupId} sequence=${inviteCardSequence}`,
      );
    }

    return {
      kind: 'group_invite',
      time: Math.floor(this.now() / 1_000),
      selfUin: this.selfUin,
      groupId: request.groupId,
      fromUin,
      fromUid,
      subType,
      message: request.comment,
      flag: formatGroupRequestFlag(inviteCardSequence === undefined ? request : {
        groupId: request.groupId,
        sequence: inviteCardSequence,
        eventType: 2,
        filtered: false,
      }),
    };
  }

  private rememberObservedEvent(event: GroupInviteEvent): void {
    if (event.flag.startsWith('slreq:1:')) this.rememberFlag(event.flag);
    const fingerprint = eventFingerprint(event);
    this.recentFingerprints.set(fingerprint, this.now());
  }

  private rememberFlag(flag: string): void {
    if (this.seenFlags.has(flag)) return;
    this.seenFlags.set(flag, true);
    if (this.seenFlags.size <= MAX_SEEN_FLAGS) return;
    const oldest = this.seenFlags.keys().next().value;
    if (oldest !== undefined) this.seenFlags.delete(oldest);
  }

  private sweepRecentFingerprints(now: number): void {
    const oldest = now - RECENT_EVENT_WINDOW_MS;
    for (const [fingerprint, observedAt] of this.recentFingerprints) {
      if (observedAt <= oldest) this.recentFingerprints.delete(fingerprint);
    }
  }

  private async runScheduledPoll(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (error) {
      this.log.error(
        'group request scan failed: %s',
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.scheduledTask = this.runScheduledPoll();
        }, this.intervalMs);
        this.timer.unref?.();
      }
    }
  }
}

function eventFingerprint(
  event: Pick<GroupInviteEvent, 'groupId' | 'subType' | 'fromUin' | 'fromUid' | 'flag'>,
): string {
  const fromUid = event.fromUid?.trim() ?? '';
  const actor = event.fromUin > 0
    ? `uin:${event.fromUin}`
    : fromUid
      ? `uid:${fromUid}`
      : `request:${event.flag}`;
  return `${event.groupId}:${event.subType}:${actor}`;
}
