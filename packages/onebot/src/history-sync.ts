import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import {
  LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS,
  type GroupHistorySyncState,
  type PrivateHistorySyncState,
} from '@snowluma/core/apis';
import type { FriendMessage, GroupMessage } from '@snowluma/protocol/events';
import { convertEvent, type ConverterContext } from './event-converter';
import { persistHistoryEvent, toHistoryInt } from './history-persistence';
import type { MessageStore } from './message-store';

export const LOGIN_HISTORY_SYNC_LIMITS = {
  startupDelayMs: 30_000,
  scannedGroups: LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS.maxTargetsPerKind,
  scannedPrivateUsers: LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS.maxTargetsPerKind,
  maxGroups: 3,
  maxPrivateUsers: 3,
  messagesPerSession: LOGIN_HISTORY_SYNC_PROTOCOL_LIMITS.maxMessagesPerSession,
} as const;

export interface LoginHistorySyncClock {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface LoginHistorySyncRef {
  selfId: number;
  bridge: BridgeInterface;
  messageStore: MessageStore;
  converterCtx: ConverterContext;
}

export interface LoginHistorySyncResult {
  scannedGroups: number;
  scannedPrivateUsers: number;
  selectedGroups: number;
  selectedPrivateUsers: number;
  fetchedMessages: number;
  storedMessages: number;
  failedSessions: number;
  truncatedGroups: boolean;
  truncatedPrivateUsers: boolean;
}

interface GroupCandidate {
  state: GroupHistorySyncState;
  localSequence: number | null;
  priority: number;
  knownGap: boolean;
}

interface PrivateCandidate {
  state: PrivateHistorySyncState;
  localSequence: number | null;
  priority: number;
  knownGap: boolean;
}

const log = createLogger('OneBot.HistorySync');

const SYSTEM_CLOCK: LoginHistorySyncClock = {
  sleep: (ms, signal) => abortableSleep(ms, signal),
};

/**
 * Process-wide coordinator for automatic login backfill.
 *
 * The 30-second grace period happens before entering the global FIFO, so one
 * account waiting out startup does not block another account that is already
 * ready. The complete per-account operation is serialized so conversion and
 * persistence cannot overlap another account's automatic sync.
 */
export class LoginHistorySyncCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly clock: LoginHistorySyncClock = SYSTEM_CLOCK) {}

  async schedule(
    ref: LoginHistorySyncRef,
    signal: AbortSignal,
  ): Promise<LoginHistorySyncResult> {
    await this.clock.sleep(LOGIN_HISTORY_SYNC_LIMITS.startupDelayMs, signal);
    throwIfAborted(signal);

    let operationStarted = false;
    const operation = this.tail.then(async () => {
      throwIfAborted(signal);
      operationStarted = true;
      return this.runAccount(ref, signal);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return rejectWhileQueuedOnAbort(operation, signal, () => operationStarted);
  }

  private async runAccount(
    ref: LoginHistorySyncRef,
    signal: AbortSignal,
  ): Promise<LoginHistorySyncResult> {
    const groups = ref.bridge.identity.groups
      .filter(group => Number.isSafeInteger(group.groupId) && group.groupId > 0);
    const privateUsers = ref.bridge.identity.friends
      .filter(friend => (
        Number.isSafeInteger(friend.uin)
        && friend.uin > 0
        && friend.uin !== ref.selfId
        && typeof friend.uid === 'string'
        && friend.uid.trim().length > 0
      ));
    const truncatedGroups = groups.length > LOGIN_HISTORY_SYNC_LIMITS.scannedGroups;
    const truncatedPrivateUsers = privateUsers.length
      > LOGIN_HISTORY_SYNC_LIMITS.scannedPrivateUsers;
    const scannedGroups = groups.slice(0, LOGIN_HISTORY_SYNC_LIMITS.scannedGroups);
    const scannedPrivateUsers = privateUsers.slice(
      0,
      LOGIN_HISTORY_SYNC_LIMITS.scannedPrivateUsers,
    );

    if (truncatedGroups || truncatedPrivateUsers) {
      log.warn(
        'login history sync roster truncated: UIN=%d groups=%d/%d private=%d/%d',
        ref.selfId,
        scannedGroups.length,
        groups.length,
        scannedPrivateUsers.length,
        privateUsers.length,
      );
    }

    throwIfAborted(signal);
    const state = await ref.bridge.apis.message.probeHistorySyncState(
      scannedGroups.map(group => group.groupId),
      scannedPrivateUsers.map(friend => ({
        userId: friend.uin,
        uid: friend.uid,
      })),
      signal,
    );
    const groupCandidates = selectGroupCandidates(ref.messageStore, state.groups);
    const privateCandidates = selectPrivateCandidates(
      ref.messageStore,
      state.privateUsers,
    );
    // URL resolvers may issue additional QQ requests for rkeys or media
    // download addresses. Automatic backfill must stay inside its one-probe
    // plus six-page packet budget, so persist only URLs already present in the
    // history response. Message-id resolution and local media indexing remain
    // enabled.
    const mediaSegmentSink = ref.converterCtx.mediaSegmentSink;
    const persistenceRef: LoginHistorySyncRef = {
      ...ref,
      converterCtx: {
        ...ref.converterCtx,
        imageUrlResolver: null,
        mediaUrlResolver: null,
        mediaSegmentSink: mediaSegmentSink
          ? (mediaType, element, data, isGroup, sessionId) => {
            throwIfAborted(signal);
            mediaSegmentSink(mediaType, element, data, isGroup, sessionId);
          }
          : null,
      },
    };

    const result: LoginHistorySyncResult = {
      scannedGroups: scannedGroups.length,
      scannedPrivateUsers: scannedPrivateUsers.length,
      selectedGroups: groupCandidates.length,
      selectedPrivateUsers: privateCandidates.length,
      fetchedMessages: 0,
      storedMessages: 0,
      failedSessions: 0,
      truncatedGroups,
      truncatedPrivateUsers,
    };
    log.info(
      'login history sync selected: UIN=%d scanned=%d/%d selected=%d/%d',
      ref.selfId,
      result.scannedGroups,
      result.scannedPrivateUsers,
      result.selectedGroups,
      result.selectedPrivateUsers,
    );

    for (const candidate of groupCandidates) {
      throwIfAborted(signal);
      try {
        const messages = await fetchGroupCandidate(persistenceRef, candidate, signal);
        throwIfAborted(signal);
        result.fetchedMessages += messages.length;
        for (const message of messages) {
          throwIfAborted(signal);
          await persistGroupMessage(persistenceRef, message, signal);
          result.storedMessages += 1;
        }
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal);
        result.failedSessions += 1;
        log.warn(
          'login history sync group failed: UIN=%d group=%d error=%s',
          ref.selfId,
          candidate.state.groupId,
          errorText(error),
        );
      }
    }

    for (const candidate of privateCandidates) {
      throwIfAborted(signal);
      try {
        const messages = await fetchPrivateCandidate(persistenceRef, candidate, signal);
        throwIfAborted(signal);
        result.fetchedMessages += messages.length;
        for (const message of messages) {
          throwIfAborted(signal);
          if (await persistPrivateMessage(
            persistenceRef,
            candidate.state.userId,
            message,
            signal,
          )) {
            result.storedMessages += 1;
          }
        }
      } catch (error) {
        if (signal.aborted) throwIfAborted(signal);
        result.failedSessions += 1;
        log.warn(
          'login history sync private failed: UIN=%d peer=%d error=%s',
          ref.selfId,
          candidate.state.userId,
          errorText(error),
        );
      }
    }

    log.info(
      'login history sync complete: UIN=%d fetched=%d stored=%d failed=%d',
      ref.selfId,
      result.fetchedMessages,
      result.storedMessages,
      result.failedSessions,
    );
    return result;
  }
}

export const loginHistorySyncCoordinator = new LoginHistorySyncCoordinator();

function selectGroupCandidates(
  store: MessageStore,
  states: readonly GroupHistorySyncState[],
): GroupCandidate[] {
  return states
    .flatMap((state): GroupCandidate[] => {
      if (!Number.isSafeInteger(state.latestSeq) || state.latestSeq <= 0) return [];
      const observedSequence = store.findLatestAuthoritativeSequence(true, state.groupId);
      const localSequence = store.findLatestPersistedAuthoritativeSequence(
        true,
        state.groupId,
      );
      if (localSequence !== null) {
        if (state.latestSeq <= localSequence) return [];
        return [{
          state,
          localSequence,
          priority: state.latestSeq - localSequence,
          knownGap: true,
        }];
      }
      if (observedSequence !== null) {
        return [{
          state,
          localSequence: null,
          priority: state.latestSeq,
          knownGap: true,
        }];
      }
      if (state.latestSeq <= state.readSeq) return [];
      return [{
        state,
        localSequence: null,
        priority: state.latestSeq - state.readSeq,
        knownGap: false,
      }];
    })
    .sort(compareCandidates)
    .slice(0, LOGIN_HISTORY_SYNC_LIMITS.maxGroups);
}

function selectPrivateCandidates(
  store: MessageStore,
  states: readonly PrivateHistorySyncState[],
): PrivateCandidate[] {
  return states
    .flatMap((state): PrivateCandidate[] => {
      if (!Number.isSafeInteger(state.latestSeq) || state.latestSeq <= 0) return [];
      const observedSequence = store.findLatestAuthoritativeSequence(false, state.userId);
      const localSequence = store.findLatestPersistedAuthoritativeSequence(
        false,
        state.userId,
      );
      if (localSequence !== null) {
        if (state.latestSeq <= localSequence) return [];
        return [{
          state,
          localSequence,
          priority: state.latestSeq - localSequence,
          knownGap: true,
        }];
      }
      if (!Number.isSafeInteger(state.lastMsgTime) || state.lastMsgTime <= 0) return [];
      return [{
        state,
        localSequence: null,
        priority: state.lastMsgTime,
        knownGap: observedSequence !== null,
      }];
    })
    .sort(compareCandidates)
    .slice(0, LOGIN_HISTORY_SYNC_LIMITS.maxPrivateUsers);
}

function compareCandidates<T extends {
  localSequence: number | null;
  priority: number;
  knownGap: boolean;
}>(
  left: T,
  right: T,
): number {
  if (left.knownGap !== right.knownGap) return left.knownGap ? -1 : 1;
  if ((left.localSequence !== null) !== (right.localSequence !== null)) {
    return left.localSequence !== null ? -1 : 1;
  }
  return right.priority - left.priority;
}

function fetchGroupCandidate(
  ref: LoginHistorySyncRef,
  candidate: GroupCandidate,
  signal: AbortSignal,
): Promise<GroupMessage[]> {
  const endSeq = candidate.localSequence === null
    ? candidate.state.latestSeq
    : Math.min(
      candidate.state.latestSeq,
      candidate.localSequence + LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession,
    );
  const startSeq = candidate.localSequence === null
    ? Math.max(1, endSeq - LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession + 1)
    : candidate.localSequence + 1;
  return ref.bridge.apis.message.getGroupHistorySyncPage(
    candidate.state.groupId,
    startSeq,
    endSeq,
    ref.selfId,
    signal,
  );
}

function fetchPrivateCandidate(
  ref: LoginHistorySyncRef,
  candidate: PrivateCandidate,
  signal: AbortSignal,
): Promise<FriendMessage[]> {
  if (candidate.localSequence !== null) {
    const endSeq = Math.min(
      candidate.state.latestSeq,
      candidate.localSequence + LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession,
    );
    return ref.bridge.apis.message.getC2cHistorySyncPage(
      candidate.state.uid,
      candidate.localSequence + 1,
      endSeq,
      ref.selfId,
      signal,
    );
  }
  const beforeTime = Math.min(0xffff_ffff, candidate.state.lastMsgTime + 1);
  return ref.bridge.apis.message.getC2cLatestHistorySyncPage(
    candidate.state.uid,
    LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession,
    ref.selfId,
    beforeTime,
    signal,
  );
}

async function persistGroupMessage(
  ref: LoginHistorySyncRef,
  message: GroupMessage,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const converted = await convertEvent(ref.converterCtx, message);
  throwIfAborted(signal);
  if (!converted || converted.message_type !== 'group') {
    throw new Error(
      `group history conversion failed: group=${message.groupId} seq=${message.msgSeq} `
      + `messageType=${String(converted?.message_type)}`,
    );
  }
  persistHistoryEvent(ref.messageStore, converted);
}

async function persistPrivateMessage(
  ref: LoginHistorySyncRef,
  peerUin: number,
  message: FriendMessage,
  signal: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const receivedPeer = message.peerUin ?? 0;
  if (receivedPeer > 0 && receivedPeer !== peerUin) {
    throw new Error(
      `private history peer mismatch: requested=${peerUin} received=${receivedPeer} `
      + `seq=${String(message.ntMsgSeq ?? message.msgSeq)}`,
    );
  }
  if (receivedPeer <= 0) message.peerUin = peerUin;
  const clientSequence = message.clientSeq ?? message.msgSeq;
  const sentBySelf = message.senderUin === ref.selfId;
  const converted = await convertEvent(ref.converterCtx, message);
  throwIfAborted(signal);
  if (!converted || converted.message_type !== 'private') {
    throw new Error(
      `private history conversion failed: peer=${peerUin} `
      + `seq=${String(message.ntMsgSeq ?? message.msgSeq)} `
      + `messageType=${String(converted?.message_type)}`,
    );
  }
  if (ref.messageStore.isPrivateMessageRecalled(
    peerUin,
    clientSequence,
    sentBySelf,
    message.time,
  )) {
    log.debug(
      'login history sync omitted recalled private message: UIN=%d peer=%d clientSeq=%d self=%s',
      ref.selfId,
      peerUin,
      clientSequence,
      String(sentBySelf),
    );
    return false;
  }
  if (converted.post_type === 'message_sent' && toHistoryInt(converted.target_id) === 0) {
    converted.target_id = peerUin;
  }
  persistHistoryEvent(ref.messageStore, converted, peerUin, message);
  return true;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('login history sync aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('login history sync aborted');
  }
}

function rejectWhileQueuedOnAbort<T>(
  result: Promise<T>,
  signal: AbortSignal,
  hasStarted: () => boolean,
): Promise<T> {
  if (signal.aborted && !hasStarted()) {
    return Promise.reject(signal.reason ?? new Error('login history sync aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!hasStarted()) {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason ?? new Error('login history sync aborted'));
      }
    };
    signal.addEventListener('abort', onAbort);
    result.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
