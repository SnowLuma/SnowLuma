import type { BridgeInterface } from '../bridge/bridge-interface';
import type { BridgeManager } from '../bridge/manager';
import { loadOneBotConfig } from './config';
import { OneBotInstance } from './instance';
import { createLogger } from '../utils/logger';

const log = createLogger('OneBot');
const VERBOSE_WARMUP = process.env.SNOWLUMA_VERBOSE_WARMUP === '1';

export class OneBotManager {
  private readonly instances = new Map<string, OneBotInstance>();

  bind(bridgeManager: BridgeManager): void {
    bridgeManager.setSessionStartedCallback((uin, bridge) => {
      this.onSessionStarted(uin, bridge);
    });

    bridgeManager.setSessionClosedCallback((uin) => {
      this.onSessionClosed(uin);
    });

    // Per-kind subscriptions to `bridge.events` happen inside
    // `OneBotInstance` itself; no global firehose to wire here.
  }

  getInstance(uin: string): OneBotInstance | null {
    return this.instances.get(uin) ?? null;
  }

  getInstances(): OneBotInstance[] {
    return [...this.instances.values()];
  }

  reloadConfig(uin: string): boolean {
    const instance = this.instances.get(uin);
    if (!instance) return false;

    const config = loadOneBotConfig(uin);
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

    const config = loadOneBotConfig(uin);
    const instance = new OneBotInstance(uin, bridge, config);

    const activePid = bridge.activePid;
    if (activePid !== null) {
      instance.addPid(activePid);
    }

    // Seed nickname with the UIN so the WebUI never renders blank while
    // warmup is in flight or if warmup never resolves a real nickname.
    if (!bridge.identity.nickname) bridge.identity.nickname = uin;

    this.instances.set(uin, instance);
    log.info('session started: UIN=%s', uin);

    // Warm up bridge state asynchronously (mirrors C++ warm_up_bridge_state)
    warmUpBridgeState(uin, bridge).catch((err) => {
      log.warn('warmup error for UIN %s: %s', uin, err instanceof Error ? (err.stack ?? err.message) : String(err));
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

async function warmUpBridgeState(uin: string, bridge: BridgeInterface): Promise<void> {
  const selfUin = parseInt(uin, 10) || 0;
  let selfResolved = false;

  // Step 1: Fetch friend list + derive self profile when QQ happens to
  // include self in the response. Some accounts / versions omit self,
  // which used to leave identity.nickname empty — see step 1b for the
  // explicit fallback.
  try {
    const friends = await bridge.fetchFriendList();
    log.info('friends loaded: UIN=%s count=%d', uin, friends.length);

    for (const f of friends) {
      if (f.uin === selfUin) {
        bridge.identity.setSelfProfile({
          uin: f.uin, uid: f.uid,
          nickname: f.nickname || uin,
          remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '',
        });
        bridge.identity.nickname = f.nickname || uin;
        log.debug('self info: UIN=%s uid=%s nickname=%s', uin, f.uid, f.nickname ?? '');
        selfResolved = true;
        break;
      }
    }
  } catch (e) {
    log.warn('failed to load friends for UIN %s: %s', uin, e instanceof Error ? e.message : String(e));
  }

  // Step 1b: friend-list path didn't resolve self → fetch user profile
  // directly via OIDB 0xFE1_2 so multi-account WebUI shows a nickname
  // for every injected session, not just the ones where QQ echoed self
  // back in the friend list.
  if (!selfResolved && selfUin > 0) {
    try {
      const profile = await bridge.fetchUserProfile(selfUin);
      bridge.identity.setSelfProfile(profile);
      bridge.identity.nickname = profile.nickname || uin;
      log.debug('self info via profile: UIN=%s uid=%s nickname=%s',
        uin, profile.uid, profile.nickname);
    } catch (e) {
      log.warn('failed to load self profile for UIN %s: %s',
        uin, e instanceof Error ? e.message : String(e));
    }
  }

  // Step 2: Fetch group list
  let groups: { groupId: number }[] = [];
  try {
    groups = await bridge.fetchGroupList();
    log.info('groups loaded: UIN=%s count=%d', uin, groups.length);
  } catch (e) {
    log.warn('failed to load groups for UIN %s: %s', uin, e instanceof Error ? e.message : String(e));
  }

  // Step 3: Fetch members for each group
  let loadedGroupCount = 0;
  let loadedMemberCount = 0;
  let failedGroupCount = 0;
  for (const g of groups) {
    try {
      const members = await bridge.fetchGroupMemberList(g.groupId);
      loadedGroupCount += 1;
      loadedMemberCount += members.length;
      if (VERBOSE_WARMUP) {
        log.debug('members loaded: group=%d count=%d', g.groupId, members.length);
      }
    } catch (e) {
      failedGroupCount += 1;
      log.warn('failed to load members for group %d: %s', g.groupId, e instanceof Error ? e.message : String(e));
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
