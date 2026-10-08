/**
 * Service worker registration and update handling.
 *
 * A PWA that silently serves a stale shell forever is a support nightmare, so
 * a waiting worker is surfaced to the user as a prompt rather than applied
 * behind their back - they might be mid-entry.
 */

export interface ServiceWorkerHandle {
  /** A new version is installed and waiting to take over. */
  onUpdateReady(callback: () => void): void;
  /** Activate the waiting worker and reload. */
  applyUpdate(): Promise<void>;
  /** Ask for a Background Sync wake-up when connectivity returns. */
  requestOutboxSync(): Promise<void>;
}

let waitingWorker: ServiceWorker | null = null;
let updateCallback: (() => void) | null = null;
let reloading = false;

function announceUpdate(worker: ServiceWorker) {
  waitingWorker = worker;
  updateCallback?.();
}

export function registerServiceWorker(): ServiceWorkerHandle {
  const handle: ServiceWorkerHandle = {
    onUpdateReady(callback) {
      updateCallback = callback;
      if (waitingWorker) callback();
    },
    async applyUpdate() {
      if (!waitingWorker) return;
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    },
    async requestOutboxSync() {
      try {
        const registration = await navigator.serviceWorker?.ready;
        // Background Sync is Chromium-only; absence just means we fall back to
        // the app's own online/visibility/interval triggers.
        await (registration as { sync?: { register(tag: string): Promise<void> } })?.sync?.register(
          'tally-outbox',
        );
      } catch {
        /* not supported, or permission denied */
      }
    },
  };

  if (!('serviceWorker' in navigator)) return handle;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        if (registration.waiting) announceUpdate(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // `controller` being set means this is an update, not a first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              announceUpdate(installing);
            }
          });
        });

        // Pick up a new deploy when the app is brought back to the foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update();
        });
      })
      .catch((error) => {
        console.warn('service worker registration failed', error);
      });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });

  return handle;
}
