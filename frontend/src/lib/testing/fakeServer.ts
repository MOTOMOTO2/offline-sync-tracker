/**
 * An in-memory stand-in for the Python sync server, used by the client tests.
 *
 * It implements the same contract as `backend/app/sync.py` - the same statuses,
 * the same merge-versus-conflict rule, the same idempotency ledger - so the
 * engine can be exercised over realistic offline stories without a network or a
 * running server. The authoritative implementation is still the Python one;
 * `backend/tests/` is what proves that side.
 */

import { DEFAULT_FIELDS } from '../fields';
import { OfflineError, type Transport } from '../transport';
import type {
  ConflictDetail,
  EntrySnapshot,
  FieldName,
  Fields,
  OpResult,
  PullResponse,
  PushResponse,
  WireOp,
} from '../types';

interface ChangeLogRow {
  entryId: string;
  rev: number;
  kind: WireOp['kind'];
  fields: FieldName[];
  deviceId: string;
}

export class FakeServer {
  entries = new Map<string, EntrySnapshot>();
  private changes: ChangeLogRow[] = [];
  private applied = new Map<string, OpResult>();
  private seq = 0;
  private clock = 0;

  pushCount = 0;
  pullCount = 0;

  private now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }

  /** Apply a change the way a second, already-synced device would. */
  otherDeviceEdit(entryId: string, patch: Partial<Fields>, deviceId = 'other-phone'): void {
    const entry = this.entries.get(entryId);
    if (!entry) throw new Error(`unknown entry ${entryId}`);
    this.push(deviceId, [
      {
        op_id: `other-${entryId}-${entry.rev}-${this.seq}`,
        entry_id: entryId,
        kind: 'update',
        base_rev: entry.rev,
        fields: patch,
        client_ts: this.now(),
        resolves: null,
      },
    ]);
  }

  otherDeviceDelete(entryId: string, deviceId = 'other-phone'): void {
    const entry = this.entries.get(entryId);
    if (!entry) throw new Error(`unknown entry ${entryId}`);
    this.push(deviceId, [
      {
        op_id: `other-del-${entryId}-${entry.rev}-${this.seq}`,
        entry_id: entryId,
        kind: 'delete',
        base_rev: entry.rev,
        fields: {},
        client_ts: this.now(),
        resolves: null,
      },
    ]);
  }

  private changesSince(entryId: string, baseRev: number) {
    const rows = this.changes.filter((row) => row.entryId === entryId && row.rev > baseRev);
    const fields = new Set<FieldName>();
    let deleted = false;
    for (const row of rows) {
      for (const name of row.fields) fields.add(name);
      if (row.kind === 'delete') deleted = true;
      if (row.kind === 'restore') deleted = false;
    }
    return { fields, deleted };
  }

  push(deviceId: string, ops: WireOp[]): PushResponse {
    this.pushCount += 1;
    const results: OpResult[] = [];
    const originRev = new Map<string, number>();
    const blocked = new Set<string>();

    for (const op of ops) {
      const prior = this.applied.get(op.op_id);
      if (prior) {
        results.push({ ...prior, duplicate: true });
        continue;
      }
      if (blocked.has(op.entry_id)) {
        results.push({
          op_id: op.op_id,
          entry_id: op.entry_id,
          status: 'blocked',
          entry: null,
          conflict: null,
          message: 'an earlier op for this entry conflicted',
        });
        continue;
      }

      const result = this.applyOne(deviceId, op, originRev);
      if (result.status === 'conflict') blocked.add(op.entry_id);
      if (result.status !== 'blocked') this.applied.set(op.op_id, result);
      results.push(result);
    }

    return { server_time: this.now(), cursor: this.seq, results };
  }

  private conflict(
    op: WireOp,
    entry: EntrySnapshot,
    reason: ConflictDetail['reason'],
    overlapping: FieldName[],
    serverChanged: FieldName[],
    message: string,
  ): OpResult {
    return {
      op_id: op.op_id,
      entry_id: op.entry_id,
      status: 'conflict',
      entry: structuredClone(entry),
      conflict: {
        reason,
        base_rev: op.base_rev,
        server_rev: entry.rev,
        server_deleted: entry.deleted,
        server_fields: structuredClone(entry.fields),
        server_updated_at: entry.updated_at,
        server_updated_by: entry.updated_by,
        my_kind: op.kind,
        my_fields: structuredClone(op.fields),
        my_changed_fields: Object.keys(op.fields) as FieldName[],
        server_changed_fields: serverChanged,
        overlapping_fields: overlapping,
      },
      message,
    };
  }

  private applyOne(
    deviceId: string,
    op: WireOp,
    originRev: Map<string, number>,
  ): OpResult {
    const now = this.now();
    const entry = this.entries.get(op.entry_id);

    const ok = (updated: EntrySnapshot, status: OpResult['status'], message = ''): OpResult => ({
      op_id: op.op_id,
      entry_id: op.entry_id,
      status,
      entry: structuredClone(updated),
      conflict: null,
      message,
    });

    if (op.kind === 'create') {
      if (entry) {
        return this.conflict(
          op,
          entry,
          'create_exists',
          Object.keys(op.fields) as FieldName[],
          [],
          'an entry with this id already exists',
        );
      }
      this.seq += 1;
      const created: EntrySnapshot = {
        id: op.entry_id,
        rev: 1,
        server_seq: this.seq,
        deleted: false,
        fields: { ...DEFAULT_FIELDS, ...op.fields },
        created_at: now,
        updated_at: now,
        updated_by: deviceId,
      };
      this.entries.set(op.entry_id, created);
      this.changes.push({
        entryId: op.entry_id,
        rev: 1,
        kind: 'create',
        fields: Object.keys(created.fields) as FieldName[],
        deviceId,
      });
      if (!originRev.has(op.entry_id)) originRev.set(op.entry_id, 0);
      return ok(created, 'applied');
    }

    if (!entry) {
      return {
        op_id: op.op_id,
        entry_id: op.entry_id,
        status: 'invalid',
        entry: null,
        conflict: null,
        message: 'entry does not exist on the server',
      };
    }

    if (!originRev.has(op.entry_id)) originRev.set(op.entry_id, entry.rev);
    const fastForward =
      op.base_rev === entry.rev || op.base_rev === originRev.get(op.entry_id);

    const { fields: serverChanged, deleted: deletedSince } = this.changesSince(
      op.entry_id,
      op.base_rev,
    );

    const commit = (
      next: Partial<EntrySnapshot>,
      kind: WireOp['kind'],
      changedFields: FieldName[],
    ): EntrySnapshot => {
      this.seq += 1;
      const updated: EntrySnapshot = {
        ...entry,
        ...next,
        rev: entry.rev + 1,
        server_seq: this.seq,
        updated_at: now,
        updated_by: deviceId,
      };
      this.entries.set(op.entry_id, updated);
      this.changes.push({
        entryId: op.entry_id,
        rev: updated.rev,
        kind,
        fields: changedFields,
        deviceId,
      });
      return updated;
    };

    if (op.kind === 'delete') {
      if (entry.deleted) return ok(entry, 'applied', 'entry was already deleted');
      if (!fastForward) {
        return this.conflict(
          op,
          entry,
          'delete_vs_update',
          [...serverChanged],
          [...serverChanged],
          'another device edited this entry after you deleted it',
        );
      }
      return ok(commit({ deleted: true }, 'delete', []), 'applied');
    }

    if (op.kind === 'restore') {
      if (!fastForward) {
        return this.conflict(
          op,
          entry,
          'diverged',
          Object.keys(op.fields) as FieldName[],
          [...serverChanged],
          'the entry changed again before your restore arrived',
        );
      }
      return ok(
        commit(
          { deleted: false, fields: { ...entry.fields, ...op.fields } },
          'restore',
          Object.keys(op.fields) as FieldName[],
        ),
        'applied',
      );
    }

    // update
    if (entry.deleted) {
      if (fastForward) {
        return {
          op_id: op.op_id,
          entry_id: op.entry_id,
          status: 'invalid',
          entry: structuredClone(entry),
          conflict: null,
          message: 'entry is deleted; send a restore op',
        };
      }
      return this.conflict(
        op,
        entry,
        'update_vs_delete',
        Object.keys(op.fields) as FieldName[],
        [...serverChanged],
        'another device deleted this entry while you were editing it',
      );
    }

    if (deletedSince && !fastForward) {
      return this.conflict(
        op,
        entry,
        'update_vs_delete',
        Object.keys(op.fields) as FieldName[],
        [...serverChanged],
        'this entry was deleted and brought back while you were offline',
      );
    }

    if (!fastForward) {
      const overlapping = (Object.keys(op.fields) as FieldName[]).filter((name) =>
        serverChanged.has(name),
      );
      if (overlapping.length > 0) {
        return this.conflict(
          op,
          entry,
          'field_overlap',
          overlapping,
          [...serverChanged],
          'you and another device changed the same fields',
        );
      }
      const merged = commit(
        { fields: { ...entry.fields, ...op.fields } },
        'update',
        Object.keys(op.fields) as FieldName[],
      );
      return {
        ...ok(merged, 'merged', 'merged with concurrent changes to other fields'),
        merged_with: [...serverChanged],
      };
    }

    return ok(
      commit(
        { fields: { ...entry.fields, ...op.fields } },
        'update',
        Object.keys(op.fields) as FieldName[],
      ),
      'applied',
    );
  }

  pull(since: number, limit = 200): PullResponse {
    this.pullCount += 1;
    const sorted = [...this.entries.values()]
      .filter((entry) => entry.server_seq > since)
      .sort((a, b) => a.server_seq - b.server_seq);
    const page = sorted.slice(0, limit);
    return {
      server_time: this.now(),
      cursor: page.length > 0 ? page[page.length - 1]!.server_seq : since,
      has_more: sorted.length > limit,
      changes: structuredClone(page),
    };
  }
}

export interface FakeTransport extends Transport {
  server: FakeServer;
  /** Simulate having no connection at all. */
  offline: boolean;
  /**
   * Simulate the push landing but the response never getting back - the case
   * that makes naive clients duplicate writes.
   */
  dropNextResponse: boolean;
}

export function createFakeTransport(server = new FakeServer()): FakeTransport {
  const transport: FakeTransport = {
    server,
    offline: false,
    dropNextResponse: false,

    async push(deviceId, ops) {
      if (transport.offline) throw new OfflineError();
      const response = server.push(deviceId, ops);
      if (transport.dropNextResponse) {
        transport.dropNextResponse = false;
        throw new OfflineError('response lost in flight');
      }
      return response;
    },

    async pull(since, limit) {
      if (transport.offline) throw new OfflineError();
      return server.pull(since, limit);
    },

    async health() {
      return !transport.offline;
    },
  };
  return transport;
}
