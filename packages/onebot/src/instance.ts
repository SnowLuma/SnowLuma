import { createLogger, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { formatGroup, formatMessageSegments, formatReply, formatUser } from '@snowluma/protocol/format';
import path from 'path';
import { ApiHandler } from './api-handler';
import type { ConverterContext } from './event-converter';
import { registerEventPipeline } from './event-pipeline';
import { buildApiContext, type OneBotInstanceContext } from './instance-context';
import { RKeyCache } from './instance-rkey';
import { MediaIndexer } from './media-indexer';
import { MediaStore } from './media-store';
import { MediaUrlResolver } from './media-url-resolver';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';
import { MessageStore } from './message-store';
import { sendGroupMessage, sendPrivateMessage } from './modules/message-actions';
import { buildStatusText, matchesStatusCommand, statusCooldownElapsed } from './modules/status-command';
import {
  HttpPostAdapter,
  HttpServerAdapter,
  OneBotNetworkManager,
  WsClientAdapter,
  WsServerAdapter,
  type AdapterStatus,
  type NetworkAdapterContext,
} from './network';
import { ReactionStore } from './reaction-store';
import type { JsonObject, JsonValue, MessageMeta, NetworkBase, OneBotConfig } from './types';

const moduleLog = createLogger('Event');

export class OneBotInstance {
  readonly uin: string;

  private readonly bridge: BridgeInterface;
  private readonly apiHandler: ApiHandler;
  private readonly converterCtx: ConverterContext;
  private readonly messageStore: MessageStore;
  private readonly mediaStore: MediaStore;
  private readonly reactionStore: ReactionStore;
  private readonly networkManager: OneBotNetworkManager;
  private readonly rkeyCache: RKeyCache;
  private readonly ctx: OneBotInstanceContext;
  /** Process-uptime baseline for the `#sl` status reply. */
  private readonly startedAt = Date.now();
  /** Per-conversation last-reply timestamp for the `#sl` cooldown. */
  private readonly statusCommandCooldown = new Map<string, number>();
  private disposeEventPipeline: (() => void) | null = null;

  private readonly pids = new Set<number>();
  private online = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL = 30000;
  private readonly log: Logger;

  get nickname(): string { return this.bridge.identity.nickname; }

  /** Live status of this account's OneBot network adapters. */
  getConnectionStatuses(): AdapterStatus[] {
    return this.networkManager.describeStatuses();
  }

  constructor(uin: string, bridge: BridgeInterface, config: OneBotConfig) {
    this.uin = uin;
    this.bridge = bridge;
    const uinNum = Number.parseInt(uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0
      ? moduleLog.child({ uin: uinNum })
      : moduleLog;

    this.rkeyCache = new RKeyCache();
    this.mediaStore = new MediaStore(path.join('data', this.uin, 'media.db'));
    this.messageStore = new MessageStore(path.join('data', this.uin, 'messages.json'));
    this.reactionStore = new ReactionStore(path.join('data', this.uin, 'reactions.db'));
    const mediaUrlResolver = new MediaUrlResolver(this.bridge, this.rkeyCache);
    const mediaIndexer = new MediaIndexer(this.mediaStore);
    this.converterCtx = {
      selfId: parseInt(this.uin, 10) || 0,
      imageUrlResolver: (element, isGroup) =>
        this.rkeyCache.resolveImageUrl(this.bridge, element, isGroup),
      mediaUrlResolver: (element, isGroup, sessionId) =>
        mediaUrlResolver.resolve(element, isGroup, sessionId),
      messageIdResolver: (isGroup, sessionId, sequence, eventName) =>
        hashMessageIdInt32(sequence, sessionId, eventName || (isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT)),
      mediaSegmentSink: (mediaType, element, data, isGroup, sessionId) =>
        mediaIndexer.remember(mediaType, element, data, isGroup, sessionId),
    };
    const ctx: OneBotInstanceContext = {
      uin: this.uin,
      selfId: parseInt(this.uin, 10) || 0,
      bridge: this.bridge,
      messageStore: this.messageStore,
      mediaStore: this.mediaStore,
      reactionStore: this.reactionStore,
      converterCtx: this.converterCtx,
      config,
      musicSignUrl: config.musicSignUrl,
      cacheMessageMeta: (messageId, meta) => this.cacheMessageMeta(messageId, meta),
      dispatchEvent: (event) => this.dispatchEvent(event),
    };
    this.ctx = ctx;

    this.apiHandler = new ApiHandler(buildApiContext(ctx), uinNum > 0 ? uinNum : undefined);
    this.networkManager = new OneBotNetworkManager();
    this.installAdaptersFromConfig(config);
    void this.networkManager.openAll().catch((err) => {
      this.log.warn('openAll failed: %s', err instanceof Error ? (err.stack ?? err.message) : String(err));
    });

    this.startHeartbeat();
    this.rkeyCache.warmUp(this.bridge, this.uin);
    this.disposeEventPipeline = registerEventPipeline(ctx);
  }

  reloadConfig(config: OneBotConfig): void {
    // Keep the shared context's config in sync so live readers (e.g. the
    // `#sl` handler reading `statusCommand`) pick up edits without a restart.
    this.ctx.config = config;
    void this.applyConfigDiff(config).catch((err) => {
      this.log.warn('applyConfigDiff failed: %s', err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
  }

  dispose(): void {
    this.online = false;
    this.stopHeartbeat();
    this.disposeEventPipeline?.();
    this.disposeEventPipeline = null;
    void this.networkManager.closeAll().catch((err) => {
      this.log.warn('closeAll failed: %s', err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
    this.messageStore.close();
    this.mediaStore.close();
    this.reactionStore.close();
  }

  addPid(pid: number): void {
    this.pids.add(pid);
  }

  removePid(pid: number): void {
    this.pids.delete(pid);
  }

  hasPid(pid: number): boolean {
    return this.pids.has(pid);
  }

  getPids(): number[] {
    return [...this.pids];
  }

  get empty(): boolean {
    return this.pids.size === 0;
  }

  private dispatchEvent(event: JsonObject): void {
    this.cacheMessageEvent(event);
    this.logReceivedMessage(event);
    // Built-in `#sl`: always cache + log first (a swallowed `#sl` is still
    // observable locally); only forwarding to downstream adapters is gated.
    if (this.handleStatusCommand(event)) return;
    void this.networkManager.emitEvent(event).catch((err) => {
      this.log.warn('emitEvent failed: %s', err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
  }

  /**
   * Built-in `#sl` status command. Returns `true` when the event matched AND
   * `swallow` is configured — the caller then skips `emitEvent` so downstream
   * adapters never see it. The reply itself is fired async and rate-limited
   * per conversation; matching and replying are independent of swallowing.
   */
  private handleStatusCommand(event: JsonObject): boolean {
    const cfg = this.ctx.config.statusCommand;
    if (!cfg.enabled) return false;
    const postType = event.post_type;
    if (postType !== 'message' && postType !== 'message_sent') return false;
    if (!matchesStatusCommand(event.message)) return false;

    const isGroup = event.message_type === 'group';
    const sessionId = isGroup ? toInt(event.group_id) : toInt(event.user_id);
    if (sessionId === 0) return cfg.swallow;

    const key = `${isGroup ? 'g' : 'p'}:${sessionId}`;
    const now = Date.now();
    if (statusCooldownElapsed(this.statusCommandCooldown.get(key), now, cfg.cooldownSeconds)) {
      this.statusCommandCooldown.set(key, now);
      void this.replyStatus(isGroup, sessionId).catch((err) => {
        this.log.warn('status command reply failed: %s', err instanceof Error ? err.message : String(err));
      });
    }
    return cfg.swallow;
  }

  private async replyStatus(isGroup: boolean, sessionId: number): Promise<void> {
    const text = buildStatusText({
      version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
      platform: process.platform,
      arch: process.arch,
      uptimeMs: Date.now() - this.startedAt,
    });
    if (isGroup) await sendGroupMessage(this.ctx, sessionId, text, true);
    else await sendPrivateMessage(this.ctx, sessionId, text, true);
  }

  private buildNetworkContext(): NetworkAdapterContext {
    return {
      uin: this.uin,
      api: this.apiHandler,
      buildLifecycleEvent: (subType) => this.makeLifecycleEvent(subType),
      buildHeartbeatEvent: () => this.makeHeartbeatEvent(),
    };
  }

  private installAdaptersFromConfig(config: OneBotConfig): void {
    const ctx = this.buildNetworkContext();
    for (const net of config.networks.httpServers) {
      if (net.enabled === false) continue;
      this.networkManager.register(new HttpServerAdapter(net.name, net, ctx));
    }
    for (const net of config.networks.httpClients) {
      if (net.enabled === false || !net.url) continue;
      this.networkManager.register(new HttpPostAdapter(net.name, net, ctx));
    }
    for (const net of config.networks.wsServers) {
      if (net.enabled === false) continue;
      this.networkManager.register(new WsServerAdapter(net.name, net, ctx));
    }
    for (const net of config.networks.wsClients) {
      if (net.enabled === false || !net.url) continue;
      this.networkManager.register(new WsClientAdapter(net.name, net, ctx));
    }
  }

  private async applyConfigDiff(next: OneBotConfig): Promise<void> {
    const ctx = this.buildNetworkContext();
    const desired = new Map<string, NetworkBase>();
    const factories = new Map<string, () => void>();

    for (const net of next.networks.httpServers) {
      desired.set(net.name, net);
      factories.set(net.name, () => this.networkManager.register(new HttpServerAdapter(net.name, net, ctx)));
    }
    for (const net of next.networks.httpClients) {
      desired.set(net.name, net);
      factories.set(net.name, () => this.networkManager.register(new HttpPostAdapter(net.name, net, ctx)));
    }
    for (const net of next.networks.wsServers) {
      desired.set(net.name, net);
      factories.set(net.name, () => this.networkManager.register(new WsServerAdapter(net.name, net, ctx)));
    }
    for (const net of next.networks.wsClients) {
      desired.set(net.name, net);
      factories.set(net.name, () => this.networkManager.register(new WsClientAdapter(net.name, net, ctx)));
    }

    // Close adapters whose entry has been removed entirely.
    for (const adapter of this.networkManager.list()) {
      if (!desired.has(adapter.name)) {
        await this.networkManager.closeOne(adapter.name);
      }
    }
    for (const [name, net] of desired) {
      const existing = this.networkManager.get(name);
      if (existing) {
        try {
          await existing.reload(net);
        } catch (err) {
          this.log.warn('reload [%s] failed: %s', name, err instanceof Error ? err.message : String(err));
        }
      } else if (net.enabled !== false) {
        const factory = factories.get(name);
        if (factory) {
          factory();
          await this.networkManager.get(name)?.open();
        }
      }
    }
  }

  private logReceivedMessage(event: JsonObject): void {
    const isSelf = event.post_type === 'message_sent';
    if (event.post_type !== 'message' && !isSelf) return;

    const messageId = toInt(event.message_id);
    const isGroup = event.message_type === 'group';
    const idStr = `ID:${messageId}`;
    const selfTag = isSelf ? '[自身] ' : '';
    const identity = this.bridge.identity;

    // Walk the segment array once: render via the shared formatter for
    // non-reply segments, and resolve `reply` segments through the
    // message store so the chain reference becomes legible
    // ("[回复 <user>: <body>...]" instead of "[回复:1234567890]").
    const renderedParts: string[] = [];
    const message = event.message;
    if (Array.isArray(message)) {
      for (const seg of message) {
        if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
        const type = String((seg as JsonObject).type ?? '');
        const data = (typeof (seg as JsonObject).data === 'object' && (seg as JsonObject).data !== null && !Array.isArray((seg as JsonObject).data))
          ? (seg as JsonObject).data as Record<string, unknown>
          : {};
        if (type === 'reply') {
          const replyId = toInt(data.id);
          renderedParts.push(formatReply(this.messageStore, identity, replyId));
        } else {
          renderedParts.push(formatMessageSegments([seg as JsonValue]));
        }
      }
    } else if (typeof message === 'string') {
      renderedParts.push(formatMessageSegments(message));
    }
    const content = renderedParts.join(' ').trim() || '[空消息]';

    if (isGroup) {
      const groupId = toInt(event.group_id);
      const userId = toInt(event.user_id);
      const sender = (typeof event.sender === 'object' && event.sender !== null && !Array.isArray(event.sender))
        ? event.sender as JsonObject
        : {};
      const nicknameFromEvent = (sender.card as string) || (sender.nickname as string) || '';
      const userPart = nicknameFromEvent
        ? `[${nicknameFromEvent}(${userId})]`
        : formatUser(identity, groupId, userId);
      this.log.success(`${selfTag}群 ${formatGroup(identity, groupId)} | ${userPart}: ${idStr} ${content}`);
    } else {
      const userId = toInt(event.user_id);
      const sender = (typeof event.sender === 'object' && event.sender !== null && !Array.isArray(event.sender))
        ? event.sender as JsonObject
        : {};
      const nicknameFromEvent = (sender.nickname as string) || '';
      const userPart = nicknameFromEvent
        ? `[${nicknameFromEvent}(${userId})]`
        : formatUser(identity, undefined, userId);
      this.log.success(`${selfTag}私聊 ${userPart}: ${idStr} ${content}`);
    }
  }

  private cacheMessageEvent(event: JsonObject): void {
    if (event.post_type !== 'message' && event.post_type !== 'message_sent') return;

    const messageId = toInt(event.message_id);
    if (messageId === 0) return;

    const isGroup = event.message_type === 'group';
    const sessionId = isGroup ? toInt(event.group_id) : toInt(event.user_id);
    const sequence = toInt(event.message_seq);
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;

    if (sessionId === 0) return;
    this.messageStore.storeEvent(messageId, isGroup, sessionId, sequence, eventName, event);
  }

  private cacheMessageMeta(messageId: number, meta: MessageMeta): void {
    if (!Number.isInteger(messageId) || messageId === 0) return;
    this.messageStore.storeMeta(messageId, meta);
  }

  private makeLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject {
    const selfId = parseInt(this.uin, 10) || 0;
    const time = Math.floor(Date.now() / 1000);
    return {
      time,
      self_id: selfId,
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
      status: {
        online: this.online,
        good: this.online,
      },
    };
  }
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.dispatchEvent(this.makeHeartbeatEvent());
    }, OneBotInstance.HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref?.();
  }

  private makeHeartbeatEvent(): JsonObject {
    const selfId = parseInt(this.uin, 10) || 0;
    const time = Math.floor(Date.now() / 1000);
    return {
      time,
      self_id: selfId,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: this.online, good: this.online },
      interval: OneBotInstance.HEARTBEAT_INTERVAL,
    };
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}
