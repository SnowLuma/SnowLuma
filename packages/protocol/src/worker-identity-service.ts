import path from 'node:path';
import { createLogger } from '@snowluma/common/logger';
import { StoreWorkerClient } from '@snowluma/common/store-worker';
import { IdentityService, type IdentityPersistenceStatus, type IdentityWorkerSnapshot } from './identity-service';
import type { FriendInfo, GroupMemberInfo, GroupRequestInfo, QQGroupInfo, UserProfileInfo } from './qq-info';

const log = createLogger('Identity.Worker');
type Observation = { method: string; args: unknown[] };

/** Keeps the existing authoritative memory cache; all persisted work runs in
 * the account worker. Restoring the small UID indexes also removes synchronous
 * database reads from parser/cache misses. */
export class WorkerIdentityService extends IdentityService {
  private readonly client: StoreWorkerClient;
  private readonly ready: Promise<void>;
  private hydrated = false;
  private restoring = false;
  private readonly startupObservations: Observation[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly fallbackUins = new Map<string, number>();
  private readonly fallbackUids = new Map<number, string>();
  private readonly memberUins = new Map<number, Map<string, number>>();
  private readonly memberUids = new Map<number, Map<number, string>>();
  private status: IdentityPersistenceStatus;
  private closing: Promise<void> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusRefresh: Promise<void> | null = null;

  constructor(uin: string, dataRoot = 'data') {
    super(uin, null);
    this.status = { ...super.persistenceStatus, state: 'healthy' };
    this.client = new StoreWorkerClient(uin, 'identity', [uin, path.resolve(dataRoot, uin, 'snowluma_identity.db')]);
    this.ready = this.client.call<IdentityWorkerSnapshot>('getWorkerSnapshot').then(snapshot => {
      this.restoring = true;
      try {
        super.rememberFriends(snapshot.friends);
        super.rememberGroups(snapshot.groups);
        for (const group of snapshot.groups) super.rememberGroupMembers(group.groupId, [...group.members.values()]);
        for (const user of snapshot.users) {
          if (!validMapping(user.uid, user.uin)) continue;
          this.fallbackUins.set(user.uid, user.uin);
          this.fallbackUids.set(user.uin, user.uid);
        }
        for (const member of snapshot.members) {
          if (!Number.isSafeInteger(member.group_id) || member.group_id <= 0 || !validMapping(member.uid, member.uin)) continue;
          let uins = this.memberUins.get(member.group_id);
          let uids = this.memberUids.get(member.group_id);
          if (!uins) this.memberUins.set(member.group_id, uins = new Map());
          if (!uids) this.memberUids.set(member.group_id, uids = new Map());
          uins.set(member.uid, member.uin);
          uids.set(member.uin, member.uid);
        }
        // An observation can arrive while SQLite opens. Replay it after the
        // snapshot so an old roster cannot overwrite a newer QQ observation.
        for (const observation of this.startupObservations) {
          const replay = Reflect.get(this, observation.method);
          if (typeof replay !== 'function') throw new Error('Invalid startup identity observation');
          Reflect.apply(replay, this, observation.args);
        }
        this.startupObservations.length = 0;
        this.status = snapshot.status;
        this.hydrated = true;
      } finally { this.restoring = false; }
      this.statusTimer = setInterval(() => {
        if (this.closing || this.pending.size || this.statusRefresh) return;
        this.statusRefresh = this.client.call<IdentityPersistenceStatus>('getPersistenceStatus')
          .then(status => { this.status = status; }, error => this.recordFailure('status', error))
          .finally(() => { this.statusRefresh = null; });
      }, 1_000);
      this.statusTimer.unref();
    });
    void this.ready.catch(error => this.recordFailure('initialization', error));
  }

  override get initialization(): Promise<void> | null { return this.hydrated ? null : this.ready; }
  override get persistent(): boolean { return true; }
  override get persistenceStatus(): IdentityPersistenceStatus {
    return { ...this.status, pendingWrites: this.status.pendingWrites + this.pending.size };
  }

  override findUinByUid(uid: string, groupId?: number): number | null {
    const cached = super.findUinByUid(uid, groupId);
    if (cached !== null) return cached;
    const normalized = typeof uid === 'string' ? uid.trim() : '';
    const candidates = [groupId === undefined ? undefined : this.memberUins.get(groupId)?.get(normalized), this.fallbackUins.get(normalized)];
    return candidates.find(uin => uin !== undefined && this.isDatabaseMappingCurrent(normalized, uin)) ?? null;
  }

  override findUidByUin(uin: number, groupId?: number): string | null {
    const cached = super.findUidByUin(uin, groupId);
    if (cached !== null) return cached;
    const candidates = [groupId === undefined ? undefined : this.memberUids.get(groupId)?.get(uin), this.fallbackUids.get(uin)];
    return candidates.find(uid => uid !== undefined && this.isDatabaseMappingCurrent(uid, uin)) ?? null;
  }

  private observe(method: string, args: unknown[]): void {
    if (this.restoring) return;
    const captured = structuredClone(args);
    if (!this.hydrated) this.startupObservations.push({ method, args: captured });
    const task = this.client.call<IdentityPersistenceStatus>('observeIdentity', [method, captured])
      .then(status => { this.status = status; }, error => this.recordFailure(method, error));
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private checkCapacity(): void {
    if (this.restoring) return;
    if (this.closing) throw new Error('IdentityService is closing');
    if (this.pending.size + this.status.pendingWrites >= this.status.queueCapacity) {
      throw new Error('Identity persistence worker queue is full');
    }
  }

  private recordFailure(label: string, error: unknown): void {
    this.status = { ...this.status, state: 'degraded', lastFailedLabel: label,
      suspended: this.status.suspended || !!this.client.failure || label === 'initialization',
      lastError: error instanceof Error ? error.message : String(error), lastFailureAt: Date.now() };
    log.error('identity worker failed: uin=%s operation=%s err=%s', this.uin, label, this.status.lastError);
  }

  override rememberFriends(friends: FriendInfo[]): void {
    this.checkCapacity(); super.rememberFriends(friends); this.observe('rememberFriends', [friends]);
  }
  override rememberGroups(groups: QQGroupInfo[]): void {
    this.checkCapacity(); super.rememberGroups(groups); this.observe('rememberGroups', [groups]);
  }
  override rememberGroupMembers(groupId: number, members: GroupMemberInfo[]): void {
    this.checkCapacity(); super.rememberGroupMembers(groupId, members); this.observe('rememberGroupMembers', [groupId, members]);
  }
  override rememberUserProfile(profile: UserProfileInfo): void {
    this.checkCapacity(); super.rememberUserProfile(profile); this.observe('rememberUserProfile', [profile]);
  }
  override rememberGroupRequests(requests: GroupRequestInfo[]): void {
    this.checkCapacity(); super.rememberGroupRequests(requests); this.observe('rememberGroupRequests', [requests]);
  }
  override rememberRequestIdentity(identity: Parameters<IdentityService['rememberRequestIdentity']>[0]): void {
    this.checkCapacity(); super.rememberRequestIdentity(identity); this.observe('rememberRequestIdentity', [identity]);
  }
  override rememberGroupMemberIdentity(groupId: number, identity: Parameters<IdentityService['rememberGroupMemberIdentity']>[1]): void {
    this.checkCapacity(); super.rememberGroupMemberIdentity(groupId, identity); this.observe('rememberGroupMemberIdentity', [groupId, identity]);
  }
  override rememberGroupMemberJoined(groupId: number, identity: Parameters<IdentityService['rememberGroupMemberJoined']>[1]): void {
    this.checkCapacity(); super.rememberGroupMemberJoined(groupId, identity); this.observe('rememberGroupMemberJoined', [groupId, identity]);
  }
  override updateGroupMember(groupId: number, member: GroupMemberInfo): void {
    this.checkCapacity(); super.updateGroupMember(groupId, member); this.observe('updateGroupMember', [groupId, member]);
  }
  override updateGroupRemark(groupId: number, remark: string): boolean {
    this.checkCapacity(); const updated = super.updateGroupRemark(groupId, remark); this.observe('updateGroupRemark', [groupId, remark]); return updated;
  }
  override updateFriendRemark(uid: string, uin: number, remark: string): boolean {
    this.checkCapacity(); const updated = super.updateFriendRemark(uid, uin, remark); this.observe('updateFriendRemark', [uid, uin, remark]); return updated;
  }
  override forgetGroup(groupId: number): void {
    this.checkCapacity(); super.forgetGroup(groupId); this.observe('forgetGroup', [groupId]);
  }
  override markGroupMemberInactive(groupId: number, identity: Parameters<IdentityService['markGroupMemberInactive']>[1]): void {
    this.checkCapacity(); super.markGroupMemberInactive(groupId, identity); this.observe('markGroupMemberInactive', [groupId, identity]);
  }

  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const errors: unknown[] = [];
      try { await this.ready; } catch (error) { errors.push(error); }
      if (this.statusTimer) clearInterval(this.statusTimer);
      await Promise.all([...this.pending, this.statusRefresh]);
      try { this.status = await this.client.close<IdentityPersistenceStatus>(); }
      catch (error) { errors.push(error); }
      finally {
        super.close();
        this.status = { ...this.status, state: 'closed', pendingWrites: 0 };
      }
      if (errors.length) throw new AggregateError(errors, 'Identity worker close failed');
    })();
    return this.closing;
  }
}

function validMapping(uid: string, uin: number): boolean {
  return typeof uid === 'string' && !!uid.trim() && uid === uid.trim()
    && Number.isSafeInteger(uin) && uin > 0;
}
