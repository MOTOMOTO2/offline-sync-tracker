/**
 * Shared vocabulary between the device and the server.
 *
 * The important distinction in here: an `EntrySnapshot` is what the *server*
 * last told us, while a `LocalEntry` is what the user should *see* - the
 * snapshot with every still-queued op replayed on top of it.
 */

export const FIELD_NAMES = ['occurred_on', 'amount_cents', 'category', 'merchant', 'note', 'bank'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export interface Fields {
  occurred_on: string;
  amount_cents: number;
  category: string;
  merchant: string;
  note: string;
  /** The bank account this came from or was matched to. Entries from before banks were connectable don't have it. */
  bank?: string;
}

export type FieldPatch = Partial<Fields>;

export interface EntrySnapshot {
  id: string;
  rev: number;
  server_seq: number;
  deleted: boolean;
  fields: Fields;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

export type OpKind = 'create' | 'update' | 'delete' | 'restore';

/** A queued write. Fields after `resolves` are device-local bookkeeping. */
export interface Op {
  op_id: string;
  entry_id: string;
  kind: OpKind;
  base_rev: number;
  fields: FieldPatch;
  client_ts: string;
  resolves: string | null;

  /** Device-local ordering. The outbox is a queue, and order is meaning. */
  seq: number;
  attempts: number;
  last_error: string | null;
}

/** The subset actually sent over the wire. */
export type WireOp = Pick<
  Op,
  'op_id' | 'entry_id' | 'kind' | 'base_rev' | 'fields' | 'client_ts' | 'resolves'
>;

export type OpStatus = 'applied' | 'merged' | 'conflict' | 'invalid' | 'blocked';

export type ConflictReason =
  | 'field_overlap'
  | 'update_vs_delete'
  | 'delete_vs_update'
  | 'create_exists'
  | 'diverged'
  | 'rejected';

export interface ConflictDetail {
  reason: ConflictReason;
  base_rev: number;
  server_rev: number;
  server_deleted: boolean;
  server_fields: Fields;
  server_updated_at: string;
  server_updated_by: string;
  my_kind: OpKind;
  my_fields: FieldPatch;
  my_changed_fields: FieldName[];
  server_changed_fields: FieldName[];
  overlapping_fields: FieldName[];
}

export interface OpResult {
  op_id: string;
  entry_id: string;
  status: OpStatus;
  entry: EntrySnapshot | null;
  conflict: ConflictDetail | null;
  message: string;
  duplicate?: boolean;
  merged_with?: FieldName[];
}

export interface PushResponse {
  server_time: string;
  cursor: number;
  results: OpResult[];
}

export interface PullResponse {
  server_time: string;
  cursor: number;
  has_more: boolean;
  changes: EntrySnapshot[];
}

/** An unresolved conflict, parked until the user says what they meant. */
export interface ConflictRecord {
  id: string;
  entry_id: string;
  detail: ConflictDetail;
  /** My rejected op, kept so "keep mine" can be replayed exactly. */
  op: Op;
  /** What the entry looked like on this device when the push was rejected. */
  my_fields: Fields;
  my_deleted: boolean;
  message: string;
  detected_at: string;
}

/** Server snapshot + queued ops replayed on top. What the UI renders. */
export interface LocalEntry {
  id: string;
  fields: Fields;
  deleted: boolean;
  /** Server revision this is based on. 0 means the server has never seen it. */
  rev: number;
  serverFields: Fields | null;
  updatedAt: string;
  updatedBy: string;
  /** Queued ops not yet acknowledged by the server. */
  pendingOps: number;
  /** Fields changed locally and not yet confirmed. */
  pendingFields: FieldName[];
  /** Never pushed successfully yet. */
  isNew: boolean;
  hasConflict: boolean;
}

export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'conflicts'
  | 'pending';

export interface SyncState {
  status: SyncStatus;
  online: boolean;
  syncing: boolean;
  pending: number;
  conflicts: number;
  cursor: number;
  deviceId: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Human-readable note about the last sync, e.g. "merged 1 change". */
  lastOutcome: string | null;
}

export type Resolution =
  | { type: 'mine' }
  | { type: 'theirs' }
  | { type: 'fields'; values: FieldPatch }
  | { type: 'delete' };
