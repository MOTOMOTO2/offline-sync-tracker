/**
 * The device-side sync engine.
 *
 * Every user action writes an op to the outbox and returns immediately - the
 * UI never waits on the network. A background sync pushes the outbox, applies
 * the server's verdicts, then pulls whatever other devices did.
 *
 * The engine owns an in-memory mirror of the store so React can render from a
 * stable snapshot, and write-through persists every change so a cold start on
 * a plane shows exactly what the user last saw.
 */

import { compactOps } from './compact';
import { DEFAULT_FIELDS } from './fields';
import { materialize, visibleEntries } from './materialize';
import { newDeviceId, newEntryId, newOpId } from './ids';
import type { TallyStore } from './store';
import { OfflineError, ServerError, type Transport } from './transport';
import type {
  ConflictDetail,
  ConflictRecord,
  EntrySnapshot,
  FieldName,
  FieldPatch,
  Fields,
  LocalEntry,
  Op,
  OpResult,
  Resolution,
  SyncState,
  SyncStatus,
  WireOp,
} from './types';

const META_CURSOR = 'cursor';
const META_DEVICE = 'deviceId';
const META_LAST_SYNC = 'lastSyncedAt';
const META_OP_SEQ = 'opSeq';

const PUSH_BATCH = 100;
const PULL_PAGE = 200;
const MAX_PULL_PAGES = 100;

export interface EngineSnapshot {
  entries: LocalEntry[];
  visible: LocalEntry[];
  conflicts: ConflictRecord[];
  sync: SyncState;
  ready: boolean;
}

export interface SyncEngineOptions {
  store: TallyStore;
  transport: Transport;
  now?: () => string;
  makeOpId?: () => string;
  isOnline?: () => boolean;
}

function toWireOp(op: Op): WireOp {
  return {
    op_id: op.op_id,
    entry_id: op.entry_id,
    kind: op.kind,
    base_rev: op.base_rev,
    fields: op.fields,
    client_ts: op.client_ts,
    resolves: op.resolves,
  };
}

export class SyncEngine {
  private readonly store: TallyStore;
  private readonly transport: Transport;
  private readonly now: () => string;
  private readonly makeOpId: () => string;
  private readonly isOnlineFn: () => boolean;

  private entries = new Map<string, EntrySnapshot>();
  private ops: Op[] = [];
  private conflicts = new Map<string, ConflictRecord>();

  private cursor = 0;
  private deviceId = '';
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private lastOutcome: string | null = null;
  private opSeq = 0;

  private ready = false;
  private syncing = false;
  private resyncRequested = false;
  private syncPromise: Promise<void> | null = null;
  private online: boolean;

  private listeners = new Set<() => void>();
  private snapshot: EngineSnapshot;

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date().toISOString());
    this.makeOpId = options.makeOpId ?? newOpId;
    this.isOnlineFn =
      options.isOnline ??
      (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.online = this.isOnlineFn();
    this.snapshot = this.buildSnapshot();
  }

  // -- lifecycle ---------------------------------------------------------

  async init(): Promise<void> {
    const [entries, ops, conflicts] = await Promise.all([
      this.store.allEntries(),
      this.store.allOps(),
      this.store.allConflicts(),
    ]);

    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.ops = ops;
    this.conflicts = new Map(conflicts.map((conflict) => [conflict.id, conflict]));

    this.cursor = (await this.store.getMeta<number>(META_CURSOR)) ?? 0;
    this.lastSyncedAt = (await this.store.getMeta<string>(META_LAST_SYNC)) ?? null;
    this.opSeq =
      (await this.store.getMeta<number>(META_OP_SEQ)) ??
      ops.reduce((max, op) => Math.max(max, op.seq), 0);

    let deviceId = await this.store.getMeta<string>(META_DEVICE);
    if (!deviceId) {
      deviceId = newDeviceId();
      await this.store.setMeta(META_DEVICE, deviceId);
    }
    this.deviceId = deviceId;

    this.ready = true;
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): EngineSnapshot {
    const conflicts = [...this.conflicts.values()].sort((a, b) =>
      a.detected_at < b.detected_at ? 1 : -1,
    );
    const entries = materialize([...this.entries.values()], this.ops, conflicts);
    return {
      entries,
      visible: visibleEntries(entries),
      conflicts,
      ready: this.ready,
      sync: {
        status: this.deriveStatus(),
        online: this.online,
        syncing: this.syncing,
        pending: this.ops.length,
        conflicts: this.conflicts.size,
        cursor: this.cursor,
        deviceId: this.deviceId,
        lastSyncedAt: this.lastSyncedAt,
        lastError: this.lastError,
        lastOutcome: this.lastOutcome,
      },
    };
  }

  private deriveStatus(): SyncStatus {
    if (this.syncing) return 'syncing';
    if (this.conflicts.size > 0) return 'conflicts';
    if (!this.online) return 'offline';
    if (this.lastError) return 'error';
    if (this.ops.length > 0) return 'pending';
    return 'idle';
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (online) this.lastError = null;
    this.emit();
  }

  // -- local reads -------------------------------------------------------

  private localEntry(id: string): LocalEntry | undefined {
    return this.snapshot.entries.find((entry) => entry.id === id);
  }

  // -- writes ------------------------------------------------------------

  private async enqueue(
    entryId: string,
    kind: Op['kind'],
    fields: FieldPatch,
    baseRev: number,
    resolves: string | null = null,
  ): Promise<Op> {
    this.opSeq += 1;
    const op: Op = {
      op_id: this.makeOpId(),
      entry_id: entryId,
      kind,
      base_rev: baseRev,
      fields,
      client_ts: this.now(),
      resolves,
      seq: this.opSeq,
      attempts: 0,
      last_error: null,
    };

    this.ops = [...this.ops, op];
    await this.store.putOps([op]);
    await this.store.setMeta(META_OP_SEQ, this.opSeq);
    this.emit();
    return op;
  }

  async addEntry(fields: FieldPatch): Promise<string> {
    const entryId = newEntryId();
    await this.enqueue(entryId, 'create', { ...DEFAULT_FIELDS, ...fields }, 0);
    void this.sync();
    return entryId;
  }

  async updateEntry(entryId: string, patch: FieldPatch): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const local = this.localEntry(entryId);
    if (!local) return;
    // A locally-created entry the server has never seen stays a create, so it
    // does not turn into an update against a revision that does not exist.
    const kind: Op['kind'] = local.isNew ? 'create' : local.deleted ? 'restore' : 'update';
    await this.enqueue(entryId, kind, patch, local.rev);
    void this.sync();
  }

  async deleteEntry(entryId: string): Promise<void> {
    const local = this.localEntry(entryId);
    if (!local || local.deleted) return;
    await this.enqueue(entryId, 'delete', {}, local.rev);
    void this.sync();
  }

  async restoreEntry(entryId: string): Promise<void> {
    const local = this.localEntry(entryId);
    if (!local || !local.deleted) return;
    await this.enqueue(entryId, 'restore', {}, local.rev);
    void this.sync();
  }

  // -- conflict resolution ----------------------------------------------

  /**
   * Apply the user's decision. Every branch produces an op based on the
   * revision the server actually holds, so the resolution itself lands cleanly
   * instead of bouncing off the same stale base_rev again.
   */
  async resolveConflict(conflictId: string, resolution: Resolution): Promise<void> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) return;

    if (resolution.type === 'theirs') {
      // My op was already dropped from the outbox when the conflict was filed,
      // and the snapshot already holds the server's version. Nothing to send.
      this.conflicts.delete(conflictId);
      await this.store.deleteConflict(conflictId);
      this.emit();
      return;
    }

    const { detail } = conflict;
    let kind: Op['kind'];
    let fields: FieldPatch;

    if (resolution.type === 'delete') {
      kind = 'delete';
      fields = {};
    } else if (resolution.type === 'mine' && conflict.op.kind === 'delete') {
      kind = 'delete';
      fields = {};
    } else {
      fields =
        resolution.type === 'mine' ? { ...conflict.op.fields } : { ...resolution.values };
      // Bringing back something the other device deleted needs a restore; an
      // update against a tombstone is refused by design.
      kind = detail.server_deleted ? 'restore' : 'update';
    }

    this.conflicts.delete(conflictId);
    await this.store.deleteConflict(conflictId);
    await this.enqueue(conflict.entry_id, kind, fields, detail.server_rev, conflictId);
    void this.sync();
  }

  async dismissConflict(conflictId: string): Promise<void> {
    this.conflicts.delete(conflictId);
    await this.store.deleteConflict(conflictId);
    this.emit();
  }

  // -- sync --------------------------------------------------------------

  /**
   * Push the outbox, then pull what changed elsewhere.
   *
   * Calling this while a sync is already running does not start a second one -
   * it marks that another pass is needed and returns the in-flight promise, so
   * awaiting `sync()` always means "the queue has been dealt with".
   */
  sync(): Promise<void> {
    if (!this.ready) return Promise.resolve();

    if (this.syncPromise) {
      this.resyncRequested = true;
      return this.syncPromise;
    }

    this.syncPromise = this.runSyncLoop().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async runSyncLoop(): Promise<void> {
    do {
      this.resyncRequested = false;
      await this.runSyncOnce();
    } while (this.resyncRequested);
  }

  private async runSyncOnce(): Promise<void> {
    this.syncing = true;
    this.lastOutcome = null;
    this.emit();

    try {
      const pushOutcome = await this.pushPhase();
      await this.pullPhase();

      this.lastSyncedAt = this.now();
      await this.store.setMeta(META_LAST_SYNC, this.lastSyncedAt);
      this.lastError = null;
      this.online = true;
      this.lastOutcome = pushOutcome;
    } catch (error) {
      if (error instanceof OfflineError) {
        this.online = false;
        this.lastError = null; // being offline is a state, not a failure
      } else if (error instanceof ServerError) {
        this.lastError = error.message;
      } else {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.syncing = false;
      this.emit();
    }
  }

  private async pushPhase(): Promise<string | null> {
    if (this.ops.length === 0) return null;

    await this.compactOutbox();
    if (this.ops.length === 0) return null;

    let applied = 0;
    let merged = 0;
    let conflicted = 0;

    // Snapshot of what the user currently sees, captured before the server's
    // answers start rewriting it - conflict cards need "my version".
    const localBefore = new Map(this.snapshot.entries.map((entry) => [entry.id, entry]));

    const queued = [...this.ops];
    for (let index = 0; index < queued.length; index += PUSH_BATCH) {
      const batch = queued.slice(index, index + PUSH_BATCH);
      const response = await this.transport.push(this.deviceId, batch.map(toWireOp));
      const byOpId = new Map(batch.map((op) => [op.op_id, op]));

      const settledOpIds: string[] = [];
      const touchedEntries: EntrySnapshot[] = [];

      for (const result of response.results) {
        const op = byOpId.get(result.op_id);
        if (!op) continue;

        if (result.entry) touchedEntries.push(result.entry);

        switch (result.status) {
          case 'applied':
            applied += 1;
            settledOpIds.push(op.op_id);
            break;
          case 'merged':
            merged += 1;
            settledOpIds.push(op.op_id);
            break;
          case 'conflict':
          case 'invalid': {
            conflicted += 1;
            settledOpIds.push(op.op_id);
            await this.fileConflict(op, result, localBefore.get(op.entry_id));
            break;
          }
          case 'blocked':
            // Waiting on a conflict for the same entry; keep it queued.
            op.last_error = result.message;
            op.attempts += 1;
            await this.store.putOps([op]);
            break;
        }
      }

      for (const entry of touchedEntries) this.entries.set(entry.id, entry);
      await this.store.putEntries(touchedEntries);

      if (settledOpIds.length > 0) {
        const settled = new Set(settledOpIds);
        this.ops = this.ops.filter((op) => !settled.has(op.op_id));
        await this.store.deleteOps(settledOpIds);
      }

      this.emit();
    }

    const parts: string[] = [];
    if (applied > 0) parts.push(`${applied} synced`);
    if (merged > 0) parts.push(`${merged} auto-merged`);
    if (conflicted > 0) parts.push(`${conflicted} need${conflicted === 1 ? 's' : ''} you`);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  private async compactOutbox(): Promise<void> {
    const { keep, remove } = compactOps(this.ops, this.makeOpId);
    if (remove.length === 0) return;
    // Persist before pushing so a retry reuses the same op_ids and the server's
    // idempotency ledger can recognise it.
    await this.store.deleteOps(remove);
    await this.store.putOps(keep);
    this.ops = keep;
    this.emit();
  }

  private async fileConflict(
    op: Op,
    result: OpResult,
    localBefore: LocalEntry | undefined,
  ): Promise<void> {
    const serverFields: Fields = result.entry
      ? result.entry.fields
      : (result.conflict?.server_fields ?? { ...DEFAULT_FIELDS });

    const detail: ConflictDetail = result.conflict ?? {
      // `invalid` carries no conflict block; synthesise one so the UI has a
      // single shape to render and the user still gets to decide.
      reason: 'rejected',
      base_rev: op.base_rev,
      server_rev: result.entry?.rev ?? op.base_rev,
      server_deleted: result.entry?.deleted ?? false,
      server_fields: serverFields,
      server_updated_at: result.entry?.updated_at ?? this.now(),
      server_updated_by: result.entry?.updated_by ?? 'server',
      my_kind: op.kind,
      my_fields: op.fields,
      my_changed_fields: Object.keys(op.fields) as FieldName[],
      server_changed_fields: [],
      overlapping_fields: Object.keys(op.fields) as FieldName[],
    };

    const record: ConflictRecord = {
      id: op.op_id,
      entry_id: op.entry_id,
      detail,
      op,
      my_fields: localBefore ? { ...localBefore.fields } : { ...serverFields, ...op.fields },
      my_deleted: op.kind === 'delete' ? true : (localBefore?.deleted ?? false),
      message: result.message || 'This change needs a decision.',
      detected_at: this.now(),
    };

    this.conflicts.set(record.id, record);
    await this.store.putConflict(record);
  }

  private async pullPhase(): Promise<void> {
    let cursor = this.cursor;

    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await this.transport.pull(cursor, PULL_PAGE);

      if (response.changes.length > 0) {
        for (const change of response.changes) {
          this.entries.set(change.id, change);
          this.refreshConflictAgainst(change);
        }
        await this.store.putEntries(response.changes);
      }

      cursor = response.cursor;
      if (!response.has_more) break;
    }

    if (cursor !== this.cursor) {
      this.cursor = cursor;
      await this.store.setMeta(META_CURSOR, cursor);
    }
    this.emit();
  }

  /**
   * If an entry moves again while a conflict for it is still open, re-point the
   * conflict at the newest server version. Otherwise the user would resolve
   * against a version that has already been superseded and immediately hit a
   * second conflict for the same entry.
   */
  private refreshConflictAgainst(change: EntrySnapshot): void {
    for (const conflict of this.conflicts.values()) {
      if (conflict.entry_id !== change.id) continue;
      if (change.rev <= conflict.detail.server_rev) continue;

      const myFieldNames = Object.keys(conflict.op.fields) as FieldName[];
      const nowDiffering = myFieldNames.filter(
        (name) => change.fields[name] !== conflict.op.fields[name],
      );

      const refreshed: ConflictRecord = {
        ...conflict,
        detail: {
          ...conflict.detail,
          server_rev: change.rev,
          server_deleted: change.deleted,
          server_fields: change.fields,
          server_updated_at: change.updated_at,
          server_updated_by: change.updated_by,
          overlapping_fields: change.deleted ? myFieldNames : nowDiffering,
        },
      };
      this.conflicts.set(conflict.id, refreshed);
      void this.store.putConflict(refreshed);
    }
  }

  // -- maintenance -------------------------------------------------------

  /** Wipe local state and re-pull from scratch. Used by the debug panel. */
  async reset(): Promise<void> {
    await this.store.clearAll();
    this.entries.clear();
    this.ops = [];
    this.conflicts.clear();
    this.cursor = 0;
    this.lastSyncedAt = null;
    this.lastError = null;
    this.lastOutcome = null;
    this.opSeq = 0;
    await this.store.setMeta(META_DEVICE, this.deviceId);
    this.emit();
    void this.sync();
  }
}

/**
 * Wire the engine to the browser's "you might have signal now" hints.
 *
 * `navigator.onLine` is famously optimistic - it goes true for a captive portal
 * or a wifi network with no route out - so it is a prompt to try, never proof.
 * The real signal is whether a push succeeds.
 */
export function startAutoSync(engine: SyncEngine, intervalMs = 30_000): () => void {
  const goOnline = () => {
    engine.setOnline(true);
    void engine.sync();
  };
  const goOffline = () => engine.setOnline(false);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void engine.sync();
  };
  const onServiceWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type === 'tally:flush-outbox') void engine.sync();
  };

  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  document.addEventListener('visibilitychange', onVisible);
  navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);

  const timer = setInterval(() => void engine.sync(), intervalMs);

  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
    document.removeEventListener('visibilitychange', onVisible);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    clearInterval(timer);
  };
}
