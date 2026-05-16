import path from 'path';
import type { BridgeInterface } from '../bridge/bridge-interface';
import { ApiHandler } from './api-handler';
import type { ConverterContext } from './event-converter';
import { MediaIndexer } from './media-indexer';
import { MediaStore } from './media-store';
import { MediaUrlResolver } from './media-url-resolver';
import { MessageStore } from './message-store';
import { RKeyCache } from './instance-rkey';
import { buildApiContext, type OneBotInstanceContext } from './instance-context';
import { registerEventPipeline } from './event-pipeline';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';
import type { JsonObject, MessageMeta, OneBotConfig, NetworkBase } from './types';
import {
  OneBotNetworkManager,
  WsServerAdapter,
  WsClientAdapter,
  HttpServerAdapter,
  HttpPostAdapter,
  type NetworkAdapterContext,
} from './network';
import { createLogger } from '../utils/logger';

const log = createLogger('Event');

export class OneBotInstance {
  readonly uin: string;

  private readonly bridge: BridgeInterface;
  private readonly apiHandler: ApiHandler;
  private readonly converterCtx: ConverterContext;
  private readonly messageStore: MessageStore;
  private readonly mediaStore: MediaStore;
  private readonly networkManager: OneBotNetworkManager;
  private readonly rkeyCache: RKeyCache;
  private readonly ctx: OneBotInstanceContext;
  private disposeEventPipeline: (() => void) | null = null;

  private readonly pids = new Set<number>();
  private online = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL = 30000;

  get nickname(): string { return this.bridge.identity.nickname; }

  constructor(uin: string, bridge: BridgeInterface, config: OneBotConfig) {
    this.uin = uin;
    this.bridge = bridge;

    this.rkeyCache = new RKeyCache();
    this.mediaStore = new MediaStore(path.join('data', this.uin, 'media.db'));
    this.messageStore = new MessageStore(path.join('data', this.uin, 'messages.json'));

    // The converter context's four callbacks delegate to small, focused
    // modules so this constructor doesn't carry the bridge-URL fetch
    // branching or the mediaStore field-mapping fanout inline.
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

    // Shared instance context. Only carries fields that are actually read
    // through it — api handler and network manager stay as direct fields on
    // the instance because nothing reads them via ctx.
    const ctx: OneBotInstanceContext = {
      uin: this.uin,
      selfId: parseInt(this.uin, 10) || 0,
      bridge: this.bridge,
      messageStore: this.messageStore,
      mediaStore: this.mediaStore,
      converterCtx: this.converterCtx,
      config,
      musicSignUrl: config.musicSignUrl,
      cacheMessageMeta: (messageId, meta) => this.cacheMessageMeta(messageId, meta),
      dispatchEvent: (event) => this.dispatchEvent(event),
    };
    this.ctx = ctx;

    this.apiHandler = new ApiHandler(buildApiContext(ctx));
    this.networkManager = new OneBotNetworkManager();
    this.installAdaptersFromConfig(config);
    void this.networkManager.openAll();

    this.startHeartbeat();
    this.rkeyCache.warmUp(this.bridge, this.uin);

    // Per-kind subscription on the typed event bus. Each bridge event kind
    // gets its own focused handler in `event-pipeline`; the firehose is gone.
    this.disposeEventPipeline = registerEventPipeline(ctx);
  }

  reloadConfig(config: OneBotConfig): void {
    void this.applyConfigDiff(config);
  }

  dispose(): void {
    this.online = false;
    this.stopHeartbeat();
    this.disposeEventPipeline?.();
    this.disposeEventPipeline = null;
    void this.networkManager.closeAll();
    this.messageStore.close();
    this.mediaStore.close();
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
    // NetworkManager builds the dispatch payload once and fans out to every
    // active adapter in parallel via Promise.allSettled.
    void this.networkManager.emitEvent(event);
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

    // Reload existing adapters in place; spin up new ones the manager hasn't
    // seen before.
    for (const [name, net] of desired) {
      const existing = this.networkManager.get(name);
      if (existing) {
        try {
          await existing.reload(net as never);
        } catch (err) {
          log.warn('reload [%s] failed: %s', name, err instanceof Error ? err.message : String(err));
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
    
    // Build message preview
    const parts: string[] = [];
    const message = event.message;
    
    if (Array.isArray(message)) {
      for (const seg of message) {
        if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
        const type = String(seg.type ?? '');
        const data: Record<string, unknown> = (
          typeof seg.data === 'object' && seg.data !== null && !Array.isArray(seg.data)
        ) ? seg.data : {};

        if (type === 'text' && data.text) {
          const text = String(data.text);
          const preview = text.length > 50 ? text.substring(0, 50) + '...' : text;
          parts.push(preview);
        } else if (type === 'image') {
          parts.push('[图片]');
        } else if (type === 'face') {
          parts.push('[表情]');
        } else if (type === 'at') {
          parts.push(`@${data.qq || ''}`);
        } else if (type === 'reply') {
          parts.push(`[回复:${data.id || ''}]`);
        } else if (type === 'record') {
          parts.push('[语音]');
        } else if (type === 'video') {
          parts.push('[视频]');
        } else {
          parts.push(`[${type}]`);
        }
      }
    }
    
    const content = parts.join(' ').trim() || '[空消息]';
    const idStr = `ID:${messageId}`;
    const selfTag = isSelf ? '[自身] ' : '';
    
    if (isGroup) {
      const groupId = toInt(event.group_id);
      const userId = toInt(event.user_id);
      const sender = event.sender as any;
      const nickname = sender?.card || sender?.nickname || String(userId);
      log.success(`${selfTag}群 ${groupId} | ${nickname}(${userId}): ${idStr} ${content}`);
    } else {
      const userId = toInt(event.user_id);
      const sender = event.sender as any;
      const nickname = sender?.nickname || String(userId);
      log.success(`${selfTag}私聊 ${nickname}(${userId}): ${idStr} ${content}`);
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

  // --- Heartbeat ---

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
