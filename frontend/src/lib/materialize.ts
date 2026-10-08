/**
 * Build what the user sees: server snapshots with the outbox replayed on top.
 *
 * This is the piece that makes the app feel like it has no network at all. A
 * tap writes an op to IndexedDB and re-materialises; whether the server ever
 * hears about it is a separate, slower story happening in the background.
 */

import { DEFAULT_FIELDS } from './fields';
import type {
  ConflictRecord,
  EntrySnapshot,
  FieldName,
  Fields,
  LocalEntry,
  Op,
} from './types';

export function materialize(
  snapshots: EntrySnapshot[],
  ops: Op[],
  conflicts: ConflictRecord[] = [],
): LocalEntry[] {
  const byId = new Map<string, LocalEntry>();

  for (const snapshot of snapshots) {
    byId.set(snapshot.id, {
      id: snapshot.id,
      fields: { ...snapshot.fields },
      deleted: snapshot.deleted,
      rev: snapshot.rev,
      serverFields: { ...snapshot.fields },
      updatedAt: snapshot.updated_at,
      updatedBy: snapshot.updated_by,
      pendingOps: 0,
      pendingFields: [],
      isNew: false,
      hasConflict: false,
    });
  }

  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    let entry = byId.get(op.entry_id);

    if (!entry) {
      if (op.kind !== 'create') continue; // op for an entry we have never seen
      entry = {
        id: op.entry_id,
        fields: { ...DEFAULT_FIELDS },
        deleted: false,
        rev: 0,
        serverFields: null,
        updatedAt: op.client_ts,
        updatedBy: 'this device',
        pendingOps: 0,
        pendingFields: [],
        isNew: true,
        hasConflict: false,
      };
      byId.set(op.entry_id, entry);
    }

    switch (op.kind) {
      case 'create':
      case 'update':
      case 'restore':
        entry.fields = { ...entry.fields, ...op.fields };
        if (op.kind === 'restore') entry.deleted = false;
        break;
      case 'delete':
        entry.deleted = true;
        break;
    }

    entry.pendingOps += 1;
    entry.updatedAt = op.client_ts;
    entry.updatedBy = 'this device';
    for (const name of Object.keys(op.fields) as FieldName[]) {
      if (!entry.pendingFields.includes(name)) entry.pendingFields.push(name);
    }
  }

  for (const conflict of conflicts) {
    const entry = byId.get(conflict.entry_id);
    if (entry) entry.hasConflict = true;
  }

  return [...byId.values()];
}

/** Newest first, by the day the expense happened, then by last touch. */
export function sortForDisplay(entries: LocalEntry[]): LocalEntry[] {
  return [...entries].sort((a, b) => {
    if (a.fields.occurred_on !== b.fields.occurred_on) {
      return a.fields.occurred_on < b.fields.occurred_on ? 1 : -1;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}

export function visibleEntries(entries: LocalEntry[]): LocalEntry[] {
  return sortForDisplay(entries.filter((entry) => !entry.deleted));
}

/** Total for a given YYYY-MM prefix, in cents. */
export function monthTotal(entries: LocalEntry[], monthPrefix: string): number {
  return entries
    .filter((entry) => !entry.deleted && entry.fields.occurred_on.startsWith(monthPrefix))
    .reduce((sum, entry) => sum + entry.fields.amount_cents, 0);
}

/** Which fields actually differ between two versions of an entry. */
export function changedFields(a: Partial<Fields>, b: Partial<Fields>): FieldName[] {
  const names = new Set<FieldName>([
    ...(Object.keys(a) as FieldName[]),
    ...(Object.keys(b) as FieldName[]),
  ]);
  return [...names].filter((name) => a[name] !== b[name]);
}
