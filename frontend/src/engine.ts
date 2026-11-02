/**
 * The engine the whole app renders from - one per signed-in account.
 *
 * A module-level binding rather than a React context value: the engine owns
 * IndexedDB handles and timers. It is made by `bootstrap` once there is a
 * session, so every component that imports it renders only after that; the
 * export is a live binding, so they see the current one.
 */

import { getAccessToken } from './lib/auth';
import { dbNameFor, IdbStore, requestPersistence } from './lib/idbStore';
import { SyncEngine, startAutoSync } from './lib/syncEngine';
import { createHttpTransport, createToggleableTransport } from './lib/transport';
import { registerServiceWorker } from './sw-register';

export const transport = createToggleableTransport(createHttpTransport('', getAccessToken));

export let engine: SyncEngine;

export const serviceWorker = registerServiceWorker();

let store: IdbStore | null = null;
let stopAutoSync: (() => void) | null = null;

export async function bootstrap(userId: string): Promise<void> {
  store = new IdbStore(dbNameFor(userId));
  engine = new SyncEngine({
    store,
    transport,
    isOnline: () => navigator.onLine && !transport.simulatedOffline,
  });
  await engine.init();
  // Best effort: ask the browser not to evict a queue of unsynced writes.
  void requestPersistence();
  stopAutoSync = startAutoSync(engine);
  void engine.sync();
  void serviceWorker.requestOutboxSync();
}

/**
 * Stop syncing and delete this account's copy on the device. The caller signs
 * out of Supabase afterwards; anything still queued is lost, so it asks first.
 */
export async function forgetThisDevice(): Promise<void> {
  stopAutoSync?.();
  stopAutoSync = null;
  await store?.destroy();
  store = null;
}
