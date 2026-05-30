import { createLogger, type Logger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { HttpClientNetwork, JsonObject } from '../types';
import { IOneBotNetworkAdapter, NetworkReloadType, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { executeQuickOperation } from './quick-operation';

const moduleLog = createLogger('OneBot.POST');
const DEFAULT_TIMEOUT_MS = 5000;

export class HttpPostAdapter extends IOneBotNetworkAdapter<HttpClientNetwork> {
  private options: EventReportOptions;
  private signature_: string;
  private lastDelivery: { at: number; ok: boolean } | null = null;
  private readonly log: Logger;

  constructor(name: string, config: HttpClientNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx);
    this.options = resolveReportOptions(config);
    this.signature_ = bindingSignature(config);
    const uinNum = Number.parseInt(ctx.uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;
  }

  override get isActive(): boolean {
    return this.isEnabled;
  }

  open(): void {
    if (this.config.enabled === false) return;
    if (!this.config.url) return;
    this.isEnabled = true;
  }

  close(): void {
    this.isEnabled = false;
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'httpClient', status: 'disabled', detail: '未启用' };
    if (!this.lastDelivery) return { name: this.name, kind: 'httpClient', status: 'ok', detail: '已启用' };
    const at = new Date(this.lastDelivery.at).toTimeString().slice(0, 8);
    return this.lastDelivery.ok
      ? { name: this.name, kind: 'httpClient', status: 'ok', detail: `上次推送成功 ${at}` }
      : { name: this.name, kind: 'httpClient', status: 'warn', detail: `上次推送失败 ${at}` };
  }

  async reload(next: HttpClientNetwork): Promise<NetworkReloadType> {
    const wasEnabled = this.isEnabled;
    const willEnable = next.enabled !== false && !!next.url;

    this.config = structuredClone(next);
    this.options = resolveReportOptions(next);
    const newSig = bindingSignature(next);
    const sigChanged = newSig !== this.signature_;
    this.signature_ = newSig;

    if (sigChanged && wasEnabled) {
      this.close();
      if (willEnable) {
        this.open();
        return NetworkReloadType.Reopened;
      }
      return NetworkReloadType.Closed;
    }
    if (!wasEnabled && willEnable) {
      this.open();
      return NetworkReloadType.Opened;
    }
    if (wasEnabled && !willEnable) {
      this.close();
      return NetworkReloadType.Closed;
    }
    return NetworkReloadType.Normal;
  }

  onEvent(event: JsonObject, payload: DispatchPayload): void {
    if (!this.isEnabled) return;
    const json = pickDispatchJson(payload, this.options);
    if (json === null) return;
    void this.postEvent(json, event).catch((err) => {
      this.log.warn('[%s] postEvent threw: %s', this.name, err instanceof Error ? (err.stack ?? err.message) : String(err));
    });
  }

  private async postEvent(payload: string, event: JsonObject): Promise<void> {
    if (!this.isEnabled) return;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'OneBot',
      'X-Self-ID': this.ctx.uin,
    };
    if (this.config.accessToken) {
      headers['X-Signature'] = await computeHmacSha1(this.config.accessToken, payload);
    }

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        this.lastDelivery = { at: Date.now(), ok: true };
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          const body = await response.text();
          if (body.trim()) {
            await this.handleQuickOperation(event, body);
          }
        }
      } else {
        this.lastDelivery = { at: Date.now(), ok: false };
        this.log.warn('[%s] POST %s returned %d', this.name, this.config.url, response.status);
      }
    } catch (error) {
      this.lastDelivery = { at: Date.now(), ok: false };
      if (this.isEnabled) {
        this.log.warn('[%s] POST %s failed: %s', this.name, this.config.url, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async handleQuickOperation(event: JsonObject, responseBody: string): Promise<void> {
    try {
      const operation = JSON.parse(responseBody) as Record<string, unknown>;
      if (!operation || typeof operation !== 'object') return;
      await executeQuickOperation(event, operation, this.ctx.api);
    } catch (error) {
      this.log.warn('[%s] quick operation failed: %s', this.name, error instanceof Error ? error.message : String(error));
    }
  }
}

function bindingSignature(net: HttpClientNetwork): string {
  return `${net.url}#${net.accessToken ?? ''}#${net.timeoutMs ?? DEFAULT_TIMEOUT_MS}`;
}

async function computeHmacSha1(secret: string, payload: string): Promise<string> {
  const { createHmac } = await import('crypto');
  return 'sha1=' + createHmac('sha1', secret).update(payload).digest('hex');
}
