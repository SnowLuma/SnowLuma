import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { GroupRequestHandle, GroupRequestInfo } from '@snowluma/protocol/qq-info';

const log = createLogger('OneBot.Request');

type ParsedGroupRequestFlag =
  | ({ kind: 'canonical' } & GroupRequestHandle)
  | { kind: 'sequence'; sequence: number }
  | { kind: 'legacy'; requestType: 'add' | 'invite'; groupId: number; targetUid: string };

function positiveSafeInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${field} in group request flag`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${field} in group request flag`);
  }
  return parsed;
}

export function parseGroupRequestFlag(flag: string): ParsedGroupRequestFlag {
  if (/^\d+$/.test(flag)) {
    return { kind: 'sequence', sequence: positiveSafeInteger(flag, 'sequence') };
  }

  const parts = flag.split(':');
  if (parts[0] === 'slreq') {
    if (parts.length !== 6 || parts[1] !== '1') {
      throw new Error('unsupported canonical group request flag');
    }
    if (parts[5] !== '0' && parts[5] !== '1') {
      throw new Error('invalid filtered value in group request flag');
    }
    return {
      kind: 'canonical',
      sequence: positiveSafeInteger(parts[2], 'sequence'),
      groupId: positiveSafeInteger(parts[3], 'group_id'),
      eventType: positiveSafeInteger(parts[4], 'event_type'),
      filtered: parts[5] === '1',
    };
  }

  const requestType = parts[0];
  if ((requestType !== 'add' && requestType !== 'invite') || parts.length < 3) {
    throw new Error('invalid group request flag');
  }
  const groupId = positiveSafeInteger(parts[1], 'group_id');
  const targetUid = parts.slice(2).join(':');
  if (!targetUid) throw new Error('invalid request target in flag');
  return { kind: 'legacy', requestType, groupId, targetUid };
}

interface RequestInboxLookup {
  requests: GroupRequestInfo[];
  failures: unknown[];
}

async function fetchRequestInboxes(
  bridge: BridgeInterface,
  identityForm: 'uin' | 'uid',
): Promise<RequestInboxLookup> {
  const [main, filtered] = await Promise.allSettled([
    identityForm === 'uin'
      ? bridge.apis.contacts.fetchGroupRequests(false, 100)
      : bridge.apis.contacts.fetchGroupRequestsByUid(false, 100),
    identityForm === 'uin'
      ? bridge.apis.contacts.fetchGroupRequests(true, 100)
      : bridge.apis.contacts.fetchGroupRequestsByUid(true, 100),
  ]);

  if (main.status === 'rejected') {
    log.warn('failed to fetch main group-request inbox: %s',
      main.reason instanceof Error ? main.reason.message : String(main.reason));
  }
  if (filtered.status === 'rejected') {
    log.warn('failed to fetch filtered group-request inbox: %s',
      filtered.reason instanceof Error ? filtered.reason.message : String(filtered.reason));
  }
  const failures = [main, filtered]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 2) {
    throw new AggregateError(failures, 'failed to fetch group requests from both inboxes');
  }

  return {
    requests: [
      ...(main.status === 'fulfilled' ? main.value : []),
      ...(filtered.status === 'fulfilled' ? filtered.value : []),
    ],
    failures,
  };
}

function throwMissingGroupRequest(message: string, failures: readonly unknown[]): never {
  if (failures.length > 0) {
    throw new AggregateError(failures, `group request lookup incomplete: ${message}`);
  }
  throw new Error(message);
}

async function resolveLiveGroupRequest(
  bridge: BridgeInterface,
  handle: GroupRequestHandle,
): Promise<GroupRequestHandle & { operateTransInfo?: Uint8Array }> {
  const cardGroup = bridge.apis.contacts.findGroupInviteCardGroupBySequence?.(handle.sequence);
  // Private invite-card seq is absent from 0x10C0; keep the flag tuple (#125).
  if (cardGroup === handle.groupId) return handle;

  const lookup = await fetchRequestInboxes(bridge, 'uin');
  const live = lookup.requests.find((request) => (
    request.groupId === handle.groupId
    && request.sequence === handle.sequence
    && request.eventType > 0
  ));
  if (!live) return handle;
  return {
    sequence: live.sequence,
    groupId: live.groupId,
    eventType: live.eventType,
    filtered: live.filtered,
    operateTransInfo: live.operateTransInfo,
  };
}

async function applyGroupRequest(
  bridge: BridgeInterface,
  handle: GroupRequestHandle,
  approve: boolean,
  reason: string,
  knownLive?: GroupRequestInfo,
): Promise<void> {
  const live = knownLive ?? await resolveLiveGroupRequest(bridge, handle);
  log.debug('handling group request: group=%d sequence=%d eventType=%d filtered=%s approve=%s',
    live.groupId, live.sequence, live.eventType, live.filtered, approve);
  await bridge.apis.groupAdmin.setAddRequest(
    live.groupId,
    live.sequence,
    live.eventType,
    approve,
    reason,
    live.filtered,
    live.operateTransInfo,
  );
}

export async function handleGroupAddRequest(
  bridge: BridgeInterface,
  flag: string,
  approve: boolean,
  reason: string,
): Promise<void> {
  const parsed = parseGroupRequestFlag(flag);

  if (parsed.kind === 'canonical') {
    await applyGroupRequest(bridge, parsed, approve, reason);
    return;
  }

  if (parsed.kind === 'sequence') {
    // Private "qun.invite" cards use their Ark msgseq and never appear under
    // that sequence in 0x10C0. Resolve the reverse card cache before inboxes.
    const cardGroupId = bridge.apis.contacts.findGroupInviteCardGroupBySequence(parsed.sequence);
    if (cardGroupId) {
      await applyGroupRequest(bridge, {
        groupId: cardGroupId,
        sequence: parsed.sequence,
        eventType: 2,
        filtered: false,
      }, approve, reason);
      return;
    }

    const lookup = await fetchRequestInboxes(bridge, 'uin');
    const matching = lookup.requests.find((request) => request.sequence === parsed.sequence);
    if (!matching) {
      throwMissingGroupRequest(
        `group request sequence ${parsed.sequence} not found`,
        lookup.failures,
      );
    }
    await applyGroupRequest(bridge, matching, approve, reason, matching);
    return;
  }

  // Legacy SnowLuma flags remain accepted for events emitted by older builds.
  // A private invite card needs its msgseq rather than the 0x10C0 tuple (#125).
  if (parsed.requestType === 'invite') {
    const cardSequence = bridge.apis.contacts.getGroupInviteCardSequence(parsed.groupId);
    if (cardSequence) {
      await applyGroupRequest(bridge, {
        groupId: parsed.groupId,
        sequence: cardSequence,
        eventType: 2,
        filtered: false,
      }, approve, reason);
      return;
    }
  }

  const lookup = await fetchRequestInboxes(bridge, 'uid');
  const matching = lookup.requests.find((request) => {
    if (request.groupId !== parsed.groupId) return false;
    return parsed.requestType === 'add'
      ? request.targetUid === parsed.targetUid
      : request.invitorUid === parsed.targetUid;
  });

  // Never fall back to an arbitrary request from the same group: when a UID
  // does not match, approving another pending request is worse than failing.
  if (!matching) throwMissingGroupRequest('matching group request not found', lookup.failures);
  await applyGroupRequest(bridge, matching, approve, reason, matching);
}
