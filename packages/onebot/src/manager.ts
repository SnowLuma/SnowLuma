import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { BridgeManager } from '@snowluma/core/manager';
import { loadOneBotConfig } from './config';
import { OneBotInstance } from './instance';
import type { AdapterStatus } from './network';

const log = createLogger('OneBot');
const VERBOSE_WARMUP = process.env.SNOWLUMA_VERBOSE_WARMUP === '1';

const WARMUP_MAX_RETRIES = 3;
const WARMUP_RETRY_BASE_DELAY_MS = 1000;

/** Serial execution queue — tasks run one after another, each waiting for the
 *  previous to settle.  Used to sequence per-account warmup so N concurrent
 *  QQ sessions don't blast OIDB requests at the same time. */
class SerialQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.chain = this.chain.then(() => fn().then(resolve, reject));
    });
  }
}

/** Per-account OneBot connection health, surfaced to the WebUI dashboard. */
export interface AccountConnections {
  uin: string;
  nickname: string;
  adapters: AdapterStatus[];
}

export class OneBotManager {
  private readonly instances = new Map<string, OneBotInstance>();
  private readonly warmupQueue = new SerialQueue();

  bind(bridgeManager: BridgeManager): void {
    bridgeManager.addSessionStartedListener((uin, bridge) => {
      this.onSessionStarted(uin, bridge);
    });

    bridgeManager.addSessionClosedListener((uin) => {
      this.onSessionClosed(uin);
    });
  }

  getInstance(uin: string): OneBotInstance | null {
    return this.instances.get(uin) ?? null;
  }

  getInstances(): OneBotInstance[] {
    return [...this.instances.values()];
  }

  /** Live OneBot adapter status for every account, for the WebUI dashboard. */
  getConnectionStatuses(): AccountConnections[] {
    return this.getInstances().map((i) => ({
      uin: i.uin,
      nickname: i.nickname,
      adapters: i.getConnectionStatuses(),
    }));
  }

  reloadConfig(uin: string): boolean {
    const instance = this.instances.get(uin);
    if (!instance) return false;

    const config = loadOneBotConfig(uin, { persistDefaults: true });
    instance.reloadConfig(config);
    log.info('configuration reloaded: UIN=%s', uin);
    return true;
  }

  dispose(): void {
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }

  private onSessionStarted(uin: string, bridge: BridgeInterface): void {
    if (this.instances.has(uin)) return;

    const config = loadOneBotConfig(uin, { persistDefaults: true });
    const instance = new OneBotInstance(uin, bridge, config);

    const activePid = bridge.activePid;
    if (activePid !== null) {
      instance.addPid(activePid);
    }
    if (!bridge.identity.nickname) bridge.identity.nickname = uin;

    this.instances.set(uin, instance);
    log.info('session started: UIN=%s', uin);

    // Serialize warmup across accounts so multiple QQ sessions do not
    // fire OIDB requests concurrently during startup.  Network adapters
    // and rkey warmup are started after the contacts warmup completes.
    this.warmupQueue.enqueue(async () => {
      // Guard: session may have closed and reconnected while this task was
      // queued behind another account's warmup.  If the instance is no
      // longer current, skip — the new session's warmup task follows us in
      // the queue and will handle it.
      if (this.instances.get(uin) !== instance) {
        log.info('warmup skipped: session for UIN=%s restarted before warmup', uin);
        return;
      }
      await warmUpBridgeState(uin, bridge);
      // Guard: session may have closed/reconnected while warmup was running
      // (e.g. during OIDB retries).  Don't start a disposed instance or
      // issue OIDB/rkey work through a stale bridge.
      if (this.instances.get(uin) !== instance) {
        log.info('warmup stale: session for UIN=%s restarted during warmup', uin);
        return;
      }
      instance.start();
    });
  }

  private onSessionClosed(uin: string): void {
    const instance = this.instances.get(uin);
    if (!instance) return;

    instance.dispose();
    this.instances.delete(uin);
    log.info('session closed: UIN=%s', uin);
  }

}

/** Retry `fn` up to `maxRetries` times with exponential backoff.  Returns
 *  the first successful result, or null when all attempts fail. */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = WARMUP_MAX_RETRIES,
  baseDelayMs = WARMUP_RETRY_BASE_DELAY_MS,
): Promise<T | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        log.warn('%s attempt %d/%d failed, retrying in %dms: %s', label, i + 1, maxRetries, delay, msg);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log.warn('%s failed after %d attempts: %s', label, maxRetries, msg);
      }
    }
  }
  return null;
}

async function warmUpBridgeState(uin: string, bridge: BridgeInterface): Promise<void> {
  const selfUin = parseInt(uin, 10) || 0;
  let selfResolved = false;

  // Step 1: Fetch friend list + derive self profile when QQ happens to
  // include self in the response. Some accounts / versions omit self,
  // which used to leave identity.nickname empty — see step 1b for the
  // explicit fallback.
  const friends = await retryWithBackoff(
    () => bridge.apis.contacts.fetchFriendList(),
    `fetch friend list for ${uin}`,
  );
  if (friends) {
    log.info('friends loaded: UIN=%s count=%d', uin, friends.length);

    for (const f of friends) {
      if (f.uin === selfUin) {
        bridge.identity.setSelfProfile({
          uin: f.uin, uid: f.uid,
          nickname: f.nickname || uin,
          remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '', level: 0,
        });
        bridge.identity.nickname = f.nickname || uin;
        log.debug('self info: UIN=%s uid=%s nickname=%s', uin, f.uid, f.nickname ?? '');
        selfResolved = true;
        break;
      }
    }
  } else {
    log.warn('failed to load friends for UIN %s', uin);
  }

  // Step 1b: friend-list path didn't resolve self → fetch user profile
  // directly via OIDB 0xFE1_2 so multi-account WebUI shows a nickname
  // for every injected session, not just the ones where QQ echoed self
  // back in the friend list.
  if (!selfResolved && selfUin > 0) {
    const profile = await retryWithBackoff(
      () => bridge.apis.contacts.fetchUserProfile(selfUin),
      `fetch user profile for ${uin}`,
    );
    if (profile) {
      bridge.identity.setSelfProfile(profile);
      bridge.identity.nickname = profile.nickname || uin;
      log.debug('self info via profile: UIN=%s uid=%s nickname=%s',
        uin, profile.uid, profile.nickname);
    } else {
      log.warn('failed to load self profile for UIN %s', uin);
    }
  }

  // Step 2: Fetch group list
  let groups: { groupId: number }[] = [];
  const fetchedGroups = await retryWithBackoff(
    () => bridge.apis.contacts.fetchGroupList(),
    `fetch group list for ${uin}`,
  );
  if (fetchedGroups) {
    groups = fetchedGroups;
    log.info('groups loaded: UIN=%s count=%d', uin, groups.length);
  } else {
    log.warn('failed to load groups for UIN %s', uin);
  }

  // Step 3: Fetch members for each group
  let loadedGroupCount = 0;
  let loadedMemberCount = 0;
  let failedGroupCount = 0;
  for (const g of groups) {
    const members = await retryWithBackoff(
      () => bridge.apis.contacts.fetchGroupMemberList(g.groupId),
      `fetch member list for group ${g.groupId} (${uin})`,
      // Fewer retries per group to avoid lengthy warmup on large accounts
      2,
    );
    if (members) {
      loadedGroupCount += 1;
      loadedMemberCount += members.length;
      if (VERBOSE_WARMUP) {
        log.debug('members loaded: group=%d count=%d', g.groupId, members.length);
      }
    } else {
      failedGroupCount += 1;
      log.warn('failed to load members for group %d (UIN %s)', g.groupId, uin);
    }
  }

  log.info(
    'member warmup completed: UIN=%s groups=%d/%d members=%d failed=%d',
    uin,
    loadedGroupCount,
    groups.length,
    loadedMemberCount,
    failedGroupCount,
  );
}
