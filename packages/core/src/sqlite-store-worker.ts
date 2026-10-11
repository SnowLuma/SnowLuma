import { parentPort } from 'node:worker_threads';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MessageStore } from '@snowluma/onebot/message-store';
import { MediaStore } from '@snowluma/onebot/media-store';
import { ReactionStore } from '@snowluma/onebot/reaction-store';
import { closeSqliteCheckpoints } from '@snowluma/common/sqlite-checkpoints';
import { runWithRequestId, runWithoutRequestContext, setLogLevel, setWorkerLogRelay } from '@snowluma/common/logger';

type Store = IdentityService | MessageStore | MediaStore | ReactionStore;
interface Request {
  requestId: number;
  operation: 'open' | 'call' | 'close';
  id: number;
  kind?: string;
  args?: unknown[];
  method?: string;
  trace?: number;
  logLevel?: string;
}

if (!parentPort) throw new Error('SQLite store program must run in a worker');
const port = parentPort;
setWorkerLogRelay(record => port.postMessage({ type: 'log', record }));
const stores = new Map<number, Store>();
let tail = Promise.resolve();

async function handle(request: Request): Promise<unknown> {
  const args = request.args ?? [];
  if (request.operation === 'open') {
    if (stores.has(request.id)) throw new Error('Store already exists');
    let store: Store;
    switch (request.kind) {
      case 'identity': store = new IdentityService(String(args[0]), String(args[1])); break;
      case 'message': store = new MessageStore(String(args[0])); break;
      case 'media': store = new MediaStore(String(args[0])); break;
      case 'reaction': store = new ReactionStore(String(args[0])); break;
      default: throw new Error(`Unknown store kind: ${request.kind}`);
    }
    stores.set(request.id, store);
    return;
  }
  const store = stores.get(request.id);
  if (!store) throw new Error('Store is not open');
  if (request.operation === 'close') {
    store.close();
    const status = store instanceof IdentityService ? store.persistenceStatus : undefined;
    stores.delete(request.id);
    if (!stores.size) await closeSqliteCheckpoints();
    return status;
  }
  if (request.operation !== 'call' || !request.method || request.method === 'constructor' || request.method === 'close') {
    throw new Error('Invalid store operation');
  }
  if (request.method === 'observeIdentity' && store instanceof IdentityService) {
    const [method, values] = args;
    const observe = Reflect.get(store, String(method));
    if (typeof observe !== 'function' || !Array.isArray(values)) throw new Error('Invalid identity observation');
    Reflect.apply(observe, store, values);
    return store.persistenceStatus;
  }
  const method = Reflect.get(store, request.method);
  if (typeof method !== 'function') throw new Error(`Unknown store method: ${request.method}`);
  return Reflect.apply(method, store, args);
}

port.on('message', (request: Request) => {
  // The entire original store method runs to completion before another method.
  // This preserves transactions and ordering across media/message connections
  // to the same account's messages.db, without ever blocking the main loop.
  const process = async () => {
    if (request.logLevel) setLogLevel(request.logLevel);
    try { port.postMessage({ requestId: request.requestId, value: await handle(request) }); }
    catch (error) {
      port.postMessage({ requestId: request.requestId, error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined,
      } });
    }
  };
  tail = tail.then(() => request.trace === undefined
    ? runWithoutRequestContext(process)
    : runWithRequestId(request.trace, process));
});
