import { describe, expect, it } from 'vitest';

import { compactOps } from './compact';
import { DEFAULT_FIELDS } from './fields';
import { changedFields, materialize, monthTotal, visibleEntries } from './materialize';
import { formatMoney, parseMoney } from './format';
import type { EntrySnapshot, FieldPatch, Op } from './types';

let seq = 0;
let opCounter = 0;

function op(entryId: string, kind: Op['kind'], fields: FieldPatch = {}, baseRev = 0): Op {
  seq += 1;
  return {
    op_id: `op-${seq}`,
    entry_id: entryId,
    kind,
    base_rev: baseRev,
    fields,
    client_ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    resolves: null,
    seq,
    attempts: 0,
    last_error: null,
  };
}

function snapshot(id: string, overrides: Partial<EntrySnapshot> = {}): EntrySnapshot {
  return {
    id,
    rev: 1,
    server_seq: 1,
    deleted: false,
    fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-01' },
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    updated_by: 'other-phone',
    ...overrides,
  };
}

const makeOpId = () => `compacted-${++opCounter}`;

describe('compactOps', () => {
  it('leaves a single op alone', () => {
    const only = op('e1', 'create', { amount_cents: 100 });
    const result = compactOps([only], makeOpId);
    expect(result.keep).toEqual([only]);
    expect(result.remove).toEqual([]);
  });

  it('merges repeated updates into one, keeping the oldest base_rev', () => {
    const ops = [
      op('e1', 'update', { amount_cents: 100 }, 4),
      op('e1', 'update', { merchant: 'Coop' }, 4),
      op('e1', 'update', { amount_cents: 250 }, 4),
    ];
    const { keep, remove } = compactOps(ops, makeOpId);

    expect(keep).toHaveLength(1);
    expect(keep[0]!.kind).toBe('update');
    expect(keep[0]!.base_rev).toBe(4);
    expect(keep[0]!.fields).toEqual({ amount_cents: 250, merchant: 'Coop' });
    expect(remove).toHaveLength(3);
  });

  it('folds edits after a create back into the create', () => {
    const ops = [
      op('e1', 'create', { amount_cents: 100 }),
      op('e1', 'update', { merchant: 'Coop' }),
    ];
    const { keep } = compactOps(ops, makeOpId);
    expect(keep[0]!.kind).toBe('create');
    expect(keep[0]!.fields).toEqual({ amount_cents: 100, merchant: 'Coop' });
  });

  it('annihilates an entry created and deleted before any sync', () => {
    const ops = [
      op('e1', 'create', { amount_cents: 100 }),
      op('e1', 'update', { merchant: 'typo' }),
      op('e1', 'delete'),
    ];
    const { keep, remove, annihilated } = compactOps(ops, makeOpId);
    expect(keep).toEqual([]);
    expect(remove).toHaveLength(3);
    expect(annihilated).toEqual(['e1']);
  });

  it('collapses edits then a delete into a plain delete', () => {
    const ops = [
      op('e1', 'update', { amount_cents: 100 }, 2),
      op('e1', 'delete', {}, 2),
    ];
    const { keep } = compactOps(ops, makeOpId);
    expect(keep).toHaveLength(1);
    expect(keep[0]!.kind).toBe('delete');
    expect(keep[0]!.fields).toEqual({});
  });

  it('turns a delete the user undid into a restore', () => {
    const ops = [
      op('e1', 'delete', {}, 2),
      op('e1', 'restore', { note: 'actually keep it' }, 2),
    ];
    const { keep } = compactOps(ops, makeOpId);
    expect(keep[0]!.kind).toBe('restore');
    expect(keep[0]!.fields).toEqual({ note: 'actually keep it' });
  });

  it('keeps entries independent of each other', () => {
    const ops = [
      op('e1', 'update', { amount_cents: 1 }, 1),
      op('e2', 'update', { amount_cents: 2 }, 1),
      op('e1', 'update', { amount_cents: 3 }, 1),
    ];
    const { keep } = compactOps(ops, makeOpId);
    expect(keep).toHaveLength(2);
    expect(keep.map((o) => o.entry_id).sort()).toEqual(['e1', 'e2']);
  });

  it('preserves queue order', () => {
    const ops = [
      op('e1', 'update', { amount_cents: 1 }, 1),
      op('e2', 'update', { amount_cents: 2 }, 1),
      op('e1', 'update', { amount_cents: 3 }, 1),
      op('e2', 'update', { amount_cents: 4 }, 1),
    ];
    const { keep } = compactOps(ops, makeOpId);
    expect(keep.map((o) => o.entry_id)).toEqual(['e1', 'e2']);
  });
});

describe('materialize', () => {
  it('returns server state when the outbox is empty', () => {
    const entries = materialize([snapshot('e1', { fields: { ...DEFAULT_FIELDS, merchant: 'Coop' } })], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields.merchant).toBe('Coop');
    expect(entries[0]!.pendingOps).toBe(0);
    expect(entries[0]!.isNew).toBe(false);
  });

  it('replays queued ops on top of the server snapshot', () => {
    const entries = materialize(
      [snapshot('e1')],
      [op('e1', 'update', { merchant: 'Coop' }, 1), op('e1', 'update', { amount_cents: 999 }, 1)],
    );
    expect(entries[0]!.fields.merchant).toBe('Coop');
    expect(entries[0]!.fields.amount_cents).toBe(999);
    expect(entries[0]!.pendingOps).toBe(2);
    expect(entries[0]!.pendingFields.sort()).toEqual(['amount_cents', 'merchant']);
    // The server version is kept alongside, for the conflict UI.
    expect(entries[0]!.serverFields!.merchant).toBe('');
  });

  it('shows entries the server has never seen', () => {
    const entries = materialize([], [op('new1', 'create', { amount_cents: 500 })]);
    expect(entries[0]!.isNew).toBe(true);
    expect(entries[0]!.rev).toBe(0);
    expect(entries[0]!.serverFields).toBeNull();
  });

  it('hides locally deleted entries but keeps the record', () => {
    const entries = materialize([snapshot('e1')], [op('e1', 'delete', {}, 1)]);
    expect(entries[0]!.deleted).toBe(true);
    expect(visibleEntries(entries)).toHaveLength(0);
  });

  it('ignores ops for entries it has never heard of', () => {
    const entries = materialize([], [op('ghost', 'update', { note: 'hi' }, 3)]);
    expect(entries).toHaveLength(0);
  });

  it('flags entries that have an open conflict', () => {
    const conflict = {
      id: 'c1',
      entry_id: 'e1',
      detail: {} as never,
      op: op('e1', 'update'),
      my_fields: DEFAULT_FIELDS,
      my_deleted: false,
      message: '',
      detected_at: '2026-10-01T00:00:00Z',
    };
    const entries = materialize([snapshot('e1')], [], [conflict]);
    expect(entries[0]!.hasConflict).toBe(true);
  });

  it('sorts newest expense first', () => {
    const entries = materialize(
      [
        snapshot('old', { fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-01' } }),
        snapshot('new', { server_seq: 2, fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-07' } }),
      ],
      [],
    );
    expect(visibleEntries(entries).map((e) => e.id)).toEqual(['new', 'old']);
  });

  it('totals a month, ignoring deleted entries', () => {
    const entries = materialize(
      [
        snapshot('a', { fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-02', amount_cents: 500 } }),
        snapshot('b', { server_seq: 2, fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-09', amount_cents: 250 } }),
        snapshot('c', { server_seq: 3, deleted: true, fields: { ...DEFAULT_FIELDS, occurred_on: '2026-10-09', amount_cents: 9999 } }),
        snapshot('d', { server_seq: 4, fields: { ...DEFAULT_FIELDS, occurred_on: '2026-09-30', amount_cents: 100 } }),
      ],
      [],
    );
    expect(monthTotal(entries, '2026-10')).toBe(750);
  });
});

describe('changedFields', () => {
  it('reports only fields that actually differ', () => {
    expect(
      changedFields(
        { amount_cents: 100, note: 'same' },
        { amount_cents: 200, note: 'same' },
      ),
    ).toEqual(['amount_cents']);
  });
});

describe('money parsing', () => {
  it('round-trips through cents', () => {
    expect(parseMoney('12.50')).toBe(1250);
    expect(parseMoney('$ 4.05')).toBe(405);
    expect(parseMoney('7')).toBe(700);
    expect(formatMoney(1250)).toBe('$12.50');
    expect(formatMoney(-450)).toBe('-$4.50');
  });

  it('rejects things that are not amounts', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
  });
});
