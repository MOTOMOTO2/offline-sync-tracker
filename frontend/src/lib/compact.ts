/**
 * Outbox compaction.
 *
 * A week offline can leave a dozen queued ops for one entry, every one of them
 * stamped with the same `base_rev` (nothing bumps a revision until the server
 * sees it). Pushing them one by one is wasteful and makes conflict reports
 * confusing - the user would be asked about an intermediate value they have
 * already typed over.
 *
 * So before a push we collapse each entry's queued ops into a single op
 * expressing the user's current intent. Two cases are worth calling out:
 *
 *   create -> ... -> delete   The server never saw this entry, so the whole
 *                             group annihilates and nothing is sent.
 *   create -> ... -> update   Becomes one create carrying the merged fields.
 *
 * Compaction is persisted before the push so a retry reuses the same op_id and
 * stays idempotent.
 */

import type { Op } from './types';

export interface CompactionResult {
  /** Ops to write back to the outbox, replacing everything in `remove`. */
  keep: Op[];
  /** op_ids to delete from the outbox. */
  remove: string[];
  /** Entries whose queued ops cancelled out entirely. */
  annihilated: string[];
}

function groupByEntry(ops: Op[]): Map<string, Op[]> {
  const groups = new Map<string, Op[]>();
  for (const op of ops) {
    const existing = groups.get(op.entry_id);
    if (existing) existing.push(op);
    else groups.set(op.entry_id, [op]);
  }
  return groups;
}

export function compactOps(ops: Op[], makeOpId: () => string): CompactionResult {
  const ordered = [...ops].sort((a, b) => a.seq - b.seq);
  const keep: Op[] = [];
  const remove: string[] = [];
  const annihilated: string[] = [];

  for (const [entryId, group] of groupByEntry(ordered)) {
    if (group.length === 1) {
      keep.push(group[0]!);
      continue;
    }

    const first = group[0]!;
    const last = group[group.length - 1]!;
    const startsWithCreate = first.kind === 'create';
    const endsDeleted = last.kind === 'delete';

    if (startsWithCreate && endsDeleted) {
      // Created and deleted without ever reaching the server: send nothing.
      remove.push(...group.map((op) => op.op_id));
      annihilated.push(entryId);
      continue;
    }

    const mergedFields = group.reduce<Op['fields']>(
      (acc, op) => ({ ...acc, ...op.fields }),
      {},
    );

    let kind: Op['kind'];
    let fields: Op['fields'];
    if (endsDeleted) {
      kind = 'delete';
      fields = {};
    } else if (startsWithCreate) {
      kind = 'create';
      fields = mergedFields;
    } else {
      // A delete followed by edits means the user brought it back.
      const deletedEarlier = group.some((op) => op.kind === 'delete');
      kind = deletedEarlier || last.kind === 'restore' ? 'restore' : 'update';
      fields = mergedFields;
    }

    const compacted: Op = {
      op_id: makeOpId(),
      entry_id: entryId,
      kind,
      // The oldest queued op knows the last revision the server confirmed.
      base_rev: first.base_rev,
      fields,
      client_ts: last.client_ts,
      resolves: group.find((op) => op.resolves)?.resolves ?? null,
      seq: first.seq,
      attempts: Math.max(...group.map((op) => op.attempts)),
      last_error: last.last_error,
    };

    keep.push(compacted);
    remove.push(...group.map((op) => op.op_id));
  }

  return {
    keep: keep.sort((a, b) => a.seq - b.seq),
    remove: remove.filter((id) => !keep.some((op) => op.op_id === id)),
    annihilated,
  };
}
