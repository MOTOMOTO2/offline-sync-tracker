/**
 * IndexedDB implementation of `TallyStore`.
 *
 * Hand-rolled rather than pulling in a wrapper library: it is about a hundred
 * lines, and the durability of this store is the whole product. localStorage
 * would not do - it is synchronous, string-only, and the first thing browsers
 * evict under storage pressure.
 */

import { sortOps, type TallyStore } from './store';
import type { ConflictRecord, EntrySnapshot, Op } from './types';

const DB_NAME = 'tally';
const DB_VERSION = 1;

const ENTRIES = 'entries';
const OPS = 'ops';
const CONFLICTS = 'conflicts';
const META = 'meta';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export class IdbStore implements TallyStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES)) {
          db.createObjectStore(ENTRIES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(OPS)) {
          const ops = db.createObjectStore(OPS, { keyPath: 'op_id' });
          ops.createIndex('seq', 'seq');
        }
        if (!db.objectStoreNames.contains(CONFLICTS)) {
          db.createObjectStore(CONFLICTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('could not open IndexedDB'));
      req.onblocked = () =>
        reject(new Error('IndexedDB upgrade blocked by another open tab'));
    });
    return this.dbPromise;
  }

  private async tx(
    stores: string | string[],
    mode: IDBTransactionMode,
  ): Promise<IDBTransaction> {
    const db = await this.open();
    return db.transaction(stores, mode);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const tx = await this.tx(META, 'readonly');
    const row = await request<{ key: string; value: T } | undefined>(
      tx.objectStore(META).get(key),
    );
    return row?.value;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = await this.tx(META, 'readwrite');
    tx.objectStore(META).put({ key, value });
    await finished(tx);
  }

  async allEntries(): Promise<EntrySnapshot[]> {
    const tx = await this.tx(ENTRIES, 'readonly');
    return request<EntrySnapshot[]>(tx.objectStore(ENTRIES).getAll());
  }

  async putEntries(entries: EntrySnapshot[]): Promise<void> {
    if (entries.length === 0) return;
    const tx = await this.tx(ENTRIES, 'readwrite');
    const store = tx.objectStore(ENTRIES);
    for (const entry of entries) store.put(entry);
    await finished(tx);
  }

  async allOps(): Promise<Op[]> {
    const tx = await this.tx(OPS, 'readonly');
    const ops = await request<Op[]>(tx.objectStore(OPS).getAll());
    return sortOps(ops);
  }

  async putOps(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const tx = await this.tx(OPS, 'readwrite');
    const store = tx.objectStore(OPS);
    for (const op of ops) store.put(op);
    await finished(tx);
  }

  async deleteOps(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return;
    const tx = await this.tx(OPS, 'readwrite');
    const store = tx.objectStore(OPS);
    for (const id of opIds) store.delete(id);
    await finished(tx);
  }

  async allConflicts(): Promise<ConflictRecord[]> {
    const tx = await this.tx(CONFLICTS, 'readonly');
    return request<ConflictRecord[]>(tx.objectStore(CONFLICTS).getAll());
  }

  async putConflict(conflict: ConflictRecord): Promise<void> {
    const tx = await this.tx(CONFLICTS, 'readwrite');
    tx.objectStore(CONFLICTS).put(conflict);
    await finished(tx);
  }

  async deleteConflict(id: string): Promise<void> {
    const tx = await this.tx(CONFLICTS, 'readwrite');
    tx.objectStore(CONFLICTS).delete(id);
    await finished(tx);
  }

  async clearAll(): Promise<void> {
    const tx = await this.tx([ENTRIES, OPS, CONFLICTS, META], 'readwrite');
    for (const name of [ENTRIES, OPS, CONFLICTS, META]) tx.objectStore(name).clear();
    await finished(tx);
  }
}

/**
 * Ask the browser not to evict us. A tracker that silently loses a week of
 * unsynced entries to a storage sweep is worse than no tracker.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!('storage' in navigator) || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
