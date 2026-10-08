/**
 * Local persistence.
 *
 * The sync engine talks to this interface rather than to IndexedDB directly,
 * which keeps the interesting logic testable in plain Node with the in-memory
 * implementation at the bottom of this file.
 *
 * Four collections:
 *   entries   - last known server snapshots (including tombstones)
 *   ops       - the outbox: writes made on this device, not yet acknowledged
 *   conflicts - pushes the server refused, parked for the user to resolve
 *   meta      - cursor, device id, last sync time
 */

import type { ConflictRecord, EntrySnapshot, Op } from './types';

export interface TallyStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;

  allEntries(): Promise<EntrySnapshot[]>;
  putEntries(entries: EntrySnapshot[]): Promise<void>;

  allOps(): Promise<Op[]>;
  putOps(ops: Op[]): Promise<void>;
  deleteOps(opIds: string[]): Promise<void>;

  allConflicts(): Promise<ConflictRecord[]>;
  putConflict(conflict: ConflictRecord): Promise<void>;
  deleteConflict(id: string): Promise<void>;

  clearAll(): Promise<void>;
}

/** Ops come back in queue order; order is meaning for an outbox. */
export function sortOps(ops: Op[]): Op[] {
  return [...ops].sort((a, b) => a.seq - b.seq);
}

export class MemoryStore implements TallyStore {
  private meta = new Map<string, unknown>();
  private entries = new Map<string, EntrySnapshot>();
  private ops = new Map<string, Op>();
  private conflicts = new Map<string, ConflictRecord>();

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }

  async allEntries(): Promise<EntrySnapshot[]> {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  async putEntries(entries: EntrySnapshot[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.id, structuredClone(entry));
  }

  async allOps(): Promise<Op[]> {
    return sortOps([...this.ops.values()].map((op) => structuredClone(op)));
  }

  async putOps(ops: Op[]): Promise<void> {
    for (const op of ops) this.ops.set(op.op_id, structuredClone(op));
  }

  async deleteOps(opIds: string[]): Promise<void> {
    for (const id of opIds) this.ops.delete(id);
  }

  async allConflicts(): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()].map((c) => structuredClone(c));
  }

  async putConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.set(conflict.id, structuredClone(conflict));
  }

  async deleteConflict(id: string): Promise<void> {
    this.conflicts.delete(id);
  }

  async clearAll(): Promise<void> {
    this.meta.clear();
    this.entries.clear();
    this.ops.clear();
    this.conflicts.clear();
  }
}
