import { useEffect } from 'react';

import { engine } from '../engine';
import { announceBankChange, bankStatus, refreshBanks, type Imported } from '../lib/bank';

/**
 * Ask the server to check the banks when the app opens or comes back to the
 * front, then pull the ledger if anything came in. Mounted once for the whole
 * signed-in app, so it runs whichever tab is showing.
 *
 * Also re-reads each bank's history once whenever the import learns something
 * new (finer categories, spotting transfers), so earlier imports get it too.
 */

// Opening the app twice in a minute shouldn't ask the bank twice.
const REFRESH_EVERY_MS = 2 * 60_000;
// Bumped when the import learns something earlier imports should get too.
const RESORT_VERSION = 'transfers-v1';

export function changedAnything(imported: Imported | null): boolean {
  if (!imported) return false;
  const { added, matched, updated, removed, transfers = 0 } = imported;
  return added + matched + updated + removed + transfers > 0;
}

function resortedKey(userId: string): string {
  return `tally:resorted:${RESORT_VERSION}:${userId}`;
}

function needsResort(userId: string): boolean {
  try {
    return localStorage.getItem(resortedKey(userId)) === null;
  } catch {
    return false; // can't remember it was done, so don't redo it on every open
  }
}

export function useBankSync(userId: string): void {
  useEffect(() => {
    let last = 0;
    let running = false;

    const refresh = async () => {
      if (running || Date.now() - last < REFRESH_EVERY_MS || !navigator.onLine) return;
      running = true;
      last = Date.now();
      try {
        const status = await bankStatus();
        if (!status.configured || status.items.length === 0) return;
        const resort = needsResort(userId);
        const result = await refreshBanks(false, resort);
        if (resort) {
          try {
            localStorage.setItem(resortedKey(userId), new Date().toISOString());
          } catch {
            /* tried once; fine */
          }
        }
        if (changedAnything(result.imported)) void engine.sync();
        announceBankChange();
      } catch {
        /* offline, or the bank service is down: the next open tries again */
      } finally {
        running = false;
      }
    };

    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [userId]);
}
