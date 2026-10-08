import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryStore } from './store';
import { SyncEngine } from './syncEngine';
import { createFakeTransport, type FakeTransport } from './testing/fakeServer';
import type { LocalEntry } from './types';

let opCounter = 0;
let clock = 0;

function makeEngine(transport: FakeTransport, store = new MemoryStore()) {
  return new SyncEngine({
    store,
    transport,
    makeOpId: () => `op-${++opCounter}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++clock)).toISOString(),
    isOnline: () => !transport.offline,
  });
}

async function booted(transport: FakeTransport, store = new MemoryStore()) {
  const engine = makeEngine(transport, store);
  await engine.init();
  return engine;
}

function entryBy(engine: SyncEngine, predicate: (e: LocalEntry) => boolean): LocalEntry {
  const found = engine.getSnapshot().entries.find(predicate);
  if (!found) throw new Error('entry not found');
  return found;
}

beforeEach(() => {
  opCounter = 0;
  clock = 0;
});

describe('writing while offline', () => {
  it('shows a new entry immediately and keeps it queued', async () => {
    const transport = createFakeTransport();
    transport.offline = true;
    const engine = await booted(transport);

    await engine.addEntry({ amount_cents: 1250, merchant: 'Coop', occurred_on: '2026-10-05' });

    // The write is visible the instant it is made - no network involved.
    const immediate = engine.getSnapshot();
    expect(immediate.visible).toHaveLength(1);
    expect(immediate.visible[0]!.fields.merchant).toBe('Coop');
    expect(immediate.visible[0]!.isNew).toBe(true);
    expect(immediate.visible[0]!.pendingOps).toBe(1);
    expect(immediate.sync.pending).toBe(1);
    expect(transport.server.entries.size).toBe(0);

    // The background attempt that `addEntry` kicked off then fails, quietly.
    await engine.sync();
    const settled = engine.getSnapshot();
    expect(settled.sync.status).toBe('offline');
    expect(settled.sync.pending).toBe(1);
    expect(settled.visible).toHaveLength(1);
    expect(transport.server.entries.size).toBe(0);
  });

  it('flushes the queue when the connection returns', async () => {
    const transport = createFakeTransport();
    transport.offline = true;
    const engine = await booted(transport);

    await engine.addEntry({ amount_cents: 400, merchant: 'Kaffi' });
    await engine.addEntry({ amount_cents: 980, merchant: 'Bakery' });
    expect(engine.getSnapshot().sync.pending).toBe(2);

    transport.offline = false;
    engine.setOnline(true);
    await engine.sync();

    const snapshot = engine.getSnapshot();
    expect(snapshot.sync.pending).toBe(0);
    expect(snapshot.sync.status).toBe('idle');
    expect(snapshot.sync.lastSyncedAt).not.toBeNull();
    expect(snapshot.visible.every((entry) => entry.pendingOps === 0)).toBe(true);
    expect(transport.server.entries.size).toBe(2);
  });

  it('survives a restart with the queue intact', async () => {
    const store = new MemoryStore();
    const transport = createFakeTransport();
    transport.offline = true;

    const first = await booted(transport, store);
    await first.addEntry({ amount_cents: 1500, merchant: 'Pharmacy' });

    // Cold start: same device, same storage, app was killed.
    const second = await booted(transport, store);
    expect(second.getSnapshot().sync.pending).toBe(1);
    expect(second.getSnapshot().visible[0]!.fields.merchant).toBe('Pharmacy');

    transport.offline = false;
    await second.sync();
    expect(second.getSnapshot().sync.pending).toBe(0);
    expect(transport.server.entries.size).toBe(1);
  });

  it('keeps the same device id across restarts', async () => {
    const store = new MemoryStore();
    const transport = createFakeTransport();
    const first = await booted(transport, store);
    const deviceId = first.getSnapshot().sync.deviceId;

    const second = await booted(transport, store);
    expect(second.getSnapshot().sync.deviceId).toBe(deviceId);
    expect(deviceId).toMatch(/^dev_/);
  });
});

describe('outbox compaction', () => {
  it('collapses repeated offline edits into one push', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);

    const id = await engine.addEntry({ amount_cents: 1000, merchant: 'Coop' });
    await engine.sync();
    const pushesAfterCreate = transport.server.pushCount;

    transport.offline = true;
    engine.setOnline(false);
    await engine.updateEntry(id, { amount_cents: 1100 });
    await engine.updateEntry(id, { merchant: 'Coop Market' });
    await engine.updateEntry(id, { amount_cents: 1250 });
    expect(engine.getSnapshot().sync.pending).toBe(3);

    transport.offline = false;
    engine.setOnline(true);
    await engine.sync();

    // One extra push round trip, carrying one compacted op.
    expect(transport.server.pushCount).toBe(pushesAfterCreate + 1);
    const served = transport.server.entries.get(id)!;
    expect(served.fields.amount_cents).toBe(1250);
    expect(served.fields.merchant).toBe('Coop Market');
    // create + one compacted update
    expect(served.rev).toBe(2);
  });

  it('sends nothing for an entry created and deleted while offline', async () => {
    const transport = createFakeTransport();
    transport.offline = true;
    const engine = await booted(transport);

    const id = await engine.addEntry({ amount_cents: 500, merchant: 'typo' });
    await engine.updateEntry(id, { amount_cents: 600 });
    await engine.deleteEntry(id);

    transport.offline = false;
    engine.setOnline(true);
    await engine.sync();

    expect(transport.server.entries.size).toBe(0);
    expect(engine.getSnapshot().sync.pending).toBe(0);
    expect(engine.getSnapshot().visible).toHaveLength(0);
  });
});

describe('unreliable connections', () => {
  it('does not duplicate a write whose response was lost', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);

    transport.dropNextResponse = true;
    await engine.addEntry({ amount_cents: 380, merchant: 'Kaffi' });

    // The server applied it; the client never heard back, so it is still queued.
    expect(transport.server.entries.size).toBe(1);
    expect(engine.getSnapshot().sync.pending).toBe(1);

    await engine.sync();

    expect(engine.getSnapshot().sync.pending).toBe(0);
    expect(transport.server.entries.size).toBe(1);
    expect([...transport.server.entries.values()][0]!.rev).toBe(1);
    expect(engine.getSnapshot().visible).toHaveLength(1);
  });

  it('reports offline rather than an error when the network is gone', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    await engine.addEntry({ amount_cents: 100 });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(
      engine.getSnapshot().visible[0]!.id,
      { note: 'written in a tunnel' },
    );
    await engine.sync();

    const { sync } = engine.getSnapshot();
    expect(sync.online).toBe(false);
    expect(sync.status).toBe('offline');
    expect(sync.lastError).toBeNull();
    expect(sync.pending).toBe(1);
  });
});

describe('conflicts', () => {
  it('auto-merges edits to different fields', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200, merchant: '', note: '' });
    await engine.sync();

    // Another device adds the merchant while this one is offline.
    transport.offline = true;
    engine.setOnline(false);
    await engine.updateEntry(id, { amount_cents: 4650 });
    transport.server.otherDeviceEdit(id, { merchant: 'Osteria' });

    transport.offline = false;
    engine.setOnline(true);
    await engine.sync();

    const entry = entryBy(engine, (e) => e.id === id);
    expect(engine.getSnapshot().conflicts).toHaveLength(0);
    expect(entry.fields.amount_cents).toBe(4650);
    expect(entry.fields.merchant).toBe('Osteria');
    expect(engine.getSnapshot().sync.lastOutcome).toContain('auto-merged');
  });

  it('raises a conflict when both sides change the same field', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200, merchant: 'Osteria' });
    await engine.sync();

    transport.offline = true;
    engine.setOnline(false);
    await engine.updateEntry(id, { amount_cents: 4400 });
    transport.server.otherDeviceEdit(id, { amount_cents: 4650 });

    transport.offline = false;
    engine.setOnline(true);
    await engine.sync();

    const { conflicts, sync } = engine.getSnapshot();
    expect(conflicts).toHaveLength(1);
    expect(sync.status).toBe('conflicts');
    expect(sync.pending).toBe(0);

    const conflict = conflicts[0]!;
    expect(conflict.detail.reason).toBe('field_overlap');
    expect(conflict.detail.overlapping_fields).toEqual(['amount_cents']);
    expect(conflict.detail.my_fields.amount_cents).toBe(4400);
    expect(conflict.detail.server_fields.amount_cents).toBe(4650);

    // Nothing was silently overwritten: the server still holds the other value.
    expect(entryBy(engine, (e) => e.id === id).fields.amount_cents).toBe(4650);
    expect(entryBy(engine, (e) => e.id === id).hasConflict).toBe(true);
  });

  it('applies "keep mine" on top of the server version', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200 });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(id, { amount_cents: 4400 });
    transport.server.otherDeviceEdit(id, { amount_cents: 4650 });
    transport.offline = false;
    await engine.sync();

    const conflict = engine.getSnapshot().conflicts[0]!;
    await engine.resolveConflict(conflict.id, { type: 'mine' });
    await engine.sync();

    expect(engine.getSnapshot().conflicts).toHaveLength(0);
    expect(engine.getSnapshot().sync.pending).toBe(0);
    expect(transport.server.entries.get(id)!.fields.amount_cents).toBe(4400);
    expect(entryBy(engine, (e) => e.id === id).fields.amount_cents).toBe(4400);
  });

  it('applies "keep theirs" without sending anything', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200 });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(id, { amount_cents: 4400 });
    transport.server.otherDeviceEdit(id, { amount_cents: 4650 });
    transport.offline = false;
    await engine.sync();

    const pushesBefore = transport.server.pushCount;
    const conflict = engine.getSnapshot().conflicts[0]!;
    await engine.resolveConflict(conflict.id, { type: 'theirs' });

    expect(engine.getSnapshot().conflicts).toHaveLength(0);
    expect(engine.getSnapshot().sync.pending).toBe(0);
    expect(transport.server.pushCount).toBe(pushesBefore);
    expect(entryBy(engine, (e) => e.id === id).fields.amount_cents).toBe(4650);
  });

  it('applies a field-by-field resolution', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200, note: '' });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(id, { amount_cents: 4400, note: 'mine' });
    transport.server.otherDeviceEdit(id, { amount_cents: 4650, note: 'theirs' });
    transport.offline = false;
    await engine.sync();

    const conflict = engine.getSnapshot().conflicts[0]!;
    await engine.resolveConflict(conflict.id, {
      type: 'fields',
      values: { amount_cents: 4650, note: 'mine' },
    });
    await engine.sync();

    const served = transport.server.entries.get(id)!;
    expect(served.fields.amount_cents).toBe(4650);
    expect(served.fields.note).toBe('mine');
    expect(engine.getSnapshot().conflicts).toHaveLength(0);
  });

  it('raises a conflict when the other device deleted what you edited', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 999, note: '' });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(id, { note: 'receipt in the glovebox' });
    transport.server.otherDeviceDelete(id);
    transport.offline = false;
    await engine.sync();

    const conflict = engine.getSnapshot().conflicts[0]!;
    expect(conflict.detail.reason).toBe('update_vs_delete');
    expect(conflict.detail.server_deleted).toBe(true);

    // Keeping mine has to resurrect the entry, not update a tombstone.
    await engine.resolveConflict(conflict.id, { type: 'mine' });
    await engine.sync();

    const served = transport.server.entries.get(id)!;
    expect(served.deleted).toBe(false);
    expect(served.fields.note).toBe('receipt in the glovebox');
    expect(engine.getSnapshot().conflicts).toHaveLength(0);
  });

  it('raises a conflict when you deleted what the other device edited', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 999, note: '' });
    await engine.sync();

    transport.offline = true;
    await engine.deleteEntry(id);
    transport.server.otherDeviceEdit(id, { note: 'it was real, bank confirmed' });
    transport.offline = false;
    await engine.sync();

    const conflict = engine.getSnapshot().conflicts[0]!;
    expect(conflict.detail.reason).toBe('delete_vs_update');
    expect(transport.server.entries.get(id)!.deleted).toBe(false);

    // Going ahead with the delete is a deliberate second decision.
    await engine.resolveConflict(conflict.id, { type: 'mine' });
    await engine.sync();

    expect(transport.server.entries.get(id)!.deleted).toBe(true);
    expect(engine.getSnapshot().visible.find((e) => e.id === id)).toBeUndefined();
  });

  it('keeps an open conflict pointed at the newest server version', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 4200 });
    await engine.sync();

    transport.offline = true;
    await engine.updateEntry(id, { amount_cents: 4400 });
    transport.server.otherDeviceEdit(id, { amount_cents: 4650 });
    transport.offline = false;
    await engine.sync();

    // The other device moves again while the user is still deciding.
    transport.server.otherDeviceEdit(id, { amount_cents: 4700 });
    await engine.sync();

    const conflict = engine.getSnapshot().conflicts[0]!;
    expect(conflict.detail.server_fields.amount_cents).toBe(4700);

    // Resolving still lands first time, against the revision that exists now.
    await engine.resolveConflict(conflict.id, { type: 'mine' });
    await engine.sync();
    expect(engine.getSnapshot().conflicts).toHaveLength(0);
    expect(transport.server.entries.get(id)!.fields.amount_cents).toBe(4400);
  });
});

describe('pulling other devices', () => {
  it('picks up entries this device never created', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 100, merchant: 'mine' });
    await engine.sync();

    transport.server.otherDeviceEdit(id, { merchant: 'theirs' });
    await engine.sync();

    expect(entryBy(engine, (e) => e.id === id).fields.merchant).toBe('theirs');
    expect(engine.getSnapshot().sync.cursor).toBeGreaterThan(0);
  });

  it('applies tombstones from other devices', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 100 });
    await engine.sync();

    transport.server.otherDeviceDelete(id);
    await engine.sync();

    expect(engine.getSnapshot().visible).toHaveLength(0);
    expect(entryBy(engine, (e) => e.id === id).deleted).toBe(true);
  });

  it('does not re-fetch everything on each sync', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    await engine.addEntry({ amount_cents: 100 });
    await engine.sync();

    const cursor = engine.getSnapshot().sync.cursor;
    await engine.sync();
    expect(engine.getSnapshot().sync.cursor).toBe(cursor);
  });
});

describe('local edits are not clobbered by a pull', () => {
  it('keeps a queued edit visible after the server sends an older version', async () => {
    const transport = createFakeTransport();
    const engine = await booted(transport);
    const id = await engine.addEntry({ amount_cents: 1000, note: '' });
    await engine.sync();

    transport.offline = true;
    engine.setOnline(false);
    await engine.updateEntry(id, { note: 'typed on the train' });

    // A pull arrives (say the radio flickers back for the GET but not the POST).
    transport.offline = false;
    await engine.sync();

    expect(entryBy(engine, (e) => e.id === id).fields.note).toBe('typed on the train');
  });
});
