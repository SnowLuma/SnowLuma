import { createLogger } from '@snowluma/common/logger';
import { buildDispatchPayload } from '../event-filter';
import type { JsonObject, NetworkBase } from '../types';
import { IOneBotNetworkAdapter } from './adapter';

const log = createLogger('OneBot.Network');

type AnyAdapter = IOneBotNetworkAdapter<NetworkBase>;

export class OneBotNetworkManager {
  private readonly adapters = new Map<string, AnyAdapter>();

  register<C extends NetworkBase>(adapter: IOneBotNetworkAdapter<C>): void {
    const existing = this.adapters.get(adapter.name);
    if (existing) {
      // Replacing an adapter under the same name — close the previous one
      // before storing the new instance to keep ports/sockets clean.
      log.info('replacing adapter [%s]', adapter.name);
      void Promise.resolve(existing.close()).catch(() => { /* best-effort */ });
    }
    this.adapters.set(adapter.name, adapter as AnyAdapter);
  }

  has(name: string): boolean { return this.adapters.has(name); }

  get(name: string): AnyAdapter | null {
    return this.adapters.get(name) ?? null;
  }

  list(): AnyAdapter[] { return [...this.adapters.values()]; }

  hasActiveAdapters(): boolean {
    for (const a of this.adapters.values()) if (a.isActive) return true;
    return false;
  }

  async openAll(): Promise<void> {
    const tasks = this.list().map(async (a) => {
      try {
        await a.open();
      } catch (err) {
        log.error('adapter [%s] open failed: %s', a.name, errMessage(err));
      }
    });
    await Promise.all(tasks);
  }

  async closeAll(): Promise<void> {
    const tasks = this.list().map(async (a) => {
      try {
        await a.close();
      } catch (err) {
        log.warn('adapter [%s] close failed: %s', a.name, errMessage(err));
      }
    });
    await Promise.all(tasks);
    this.adapters.clear();
  }

  async closeOne(name: string): Promise<void> {
    const adapter = this.adapters.get(name);
    if (!adapter) return;
    this.adapters.delete(name);
    try {
      await adapter.close();
    } catch (err) {
      log.warn('adapter [%s] close failed: %s', adapter.name, errMessage(err));
    }
  }

  /**
   * Dispatch one canonical OneBot event to every active adapter in parallel.
   * The dispatch payload is built once so each adapter pays only the cost
   * of picking the right pre-serialized variant.
   *
   * Errors thrown inside an adapter are isolated — one bad adapter never
   * blocks the others.
   */
  async emitEvent(event: JsonObject): Promise<void> {
    if (!this.hasActiveAdapters()) return;
    const payload = buildDispatchPayload(event);
    const tasks: Promise<unknown>[] = [];
    for (const adapter of this.adapters.values()) {
      if (!adapter.isActive) continue;
      tasks.push(
        Promise.resolve()
          .then(() => adapter.onEvent(event, payload))
          .catch((err) => {
            log.warn('adapter [%s] onEvent error: %s', adapter.name, errMessage(err));
          }),
      );
    }
    await Promise.allSettled(tasks);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
