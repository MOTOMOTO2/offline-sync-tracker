/**
 * The single engine instance the whole app renders from.
 *
 * A module-level singleton rather than a React context value: the engine owns
 * IndexedDB handles and timers, and there is exactly one device.
 */

import { IdbStore, requestPersistence } from './lib/idbStore';
import { SyncEngine, startAutoSync } from './lib/syncEngine';
import { createHttpTransport, createToggleableTransport } from './lib/transport';
import { registerServiceWorker } from './sw-register';

export const transport = createToggleableTransport(createHttpTransport());

export const engine = new SyncEngine({
  store: new IdbStore(),
  transport,
  isOnline: () => navigator.onLine && !transport.simulatedOffline,
});

export const serviceWorker = registerServiceWorker();

export async function bootstrap(): Promise<void> {
  await engine.init();
  // Best effort: ask the browser not to evict a queue of unsynced writes.
  void requestPersistence();
  startAutoSync(engine);
  void engine.sync();
  void serviceWorker.requestOutboxSync();
}
