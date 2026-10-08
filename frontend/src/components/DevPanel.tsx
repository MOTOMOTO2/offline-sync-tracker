import { useState } from 'react';

import { engine, transport } from '../engine';
import { formatMoney } from '../lib/format';
import type { LocalEntry } from '../lib/types';

/**
 * A panel for proving the offline and conflict behaviour without a second
 * phone and without a lift.
 *
 * The "other device" buttons post to the demo endpoints, which write to the
 * server at its current head revision - exactly what a second, already-synced
 * device would do. Combined with the offline switch, that reproduces every
 * conflict path from one browser.
 */

async function callDemo(path: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(`/api/demo/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      return detail?.detail ?? `request failed (${response.status})`;
    }
    return null;
  } catch {
    return 'could not reach the server';
  }
}

export function DevPanel({ entries }: { entries: LocalEntry[] }) {
  const [open, setOpen] = useState(false);
  const [offline, setOffline] = useState(transport.simulatedOffline);
  const [note, setNote] = useState<string | null>(null);
  const { sync } = engine.getSnapshot();

  // The demo endpoints can only touch entries the server already knows about.
  const target = entries.find((entry) => !entry.isNew && !entry.deleted);

  const toggleOffline = (value: boolean) => {
    transport.setSimulatedOffline(value);
    setOffline(value);
    engine.setOnline(!value && navigator.onLine);
    if (!value) void engine.sync();
  };

  const act = async (label: string, run: () => Promise<string | null>) => {
    const error = await run();
    if (error) {
      setNote(error);
      return;
    }
    setNote(label);
    // Pull it in, unless the point of the exercise is to stay offline.
    if (!transport.simulatedOffline) void engine.sync();
  };

  return (
    <section className={`dev-panel ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="dev-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>Try the sync behaviour</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="dev-body">
          <label className="switch">
            <input
              type="checkbox"
              checked={offline}
              onChange={(event) => toggleOffline(event.target.checked)}
            />
            <span>
              Simulate offline
              <small>Pushes and pulls fail the way a real outage does.</small>
            </span>
          </label>

          <p className="dev-hint">
            To make a conflict: turn on <em>Simulate offline</em>, edit an expense
            below, then press <em>another device edits the amount</em>, then turn
            offline back off. Both of you changed the amount, so you get asked. Edit
            the <em>note</em> instead and it auto-merges, because nothing overlaps.
          </p>

          <div className="dev-actions">
            <button
              type="button"
              disabled={!target}
              onClick={() =>
                target &&
                act('another device changed the amount', () =>
                  callDemo('other-device-edit', {
                    entry_id: target.id,
                    fields: { amount_cents: target.fields.amount_cents + 777 },
                  }),
                )
              }
            >
              Another device edits the amount
            </button>
            <button
              type="button"
              disabled={!target}
              onClick={() =>
                target &&
                act('another device added a note', () =>
                  callDemo('other-device-edit', {
                    entry_id: target.id,
                    fields: { note: 'added from the other phone' },
                  }),
                )
              }
            >
              Another device adds a note
            </button>
            <button
              type="button"
              disabled={!target}
              onClick={() =>
                target &&
                act('another device deleted it', () =>
                  callDemo('other-device-delete', { entry_id: target.id }),
                )
              }
            >
              Another device deletes it
            </button>
          </div>

          {target ? (
            <p className="muted small">
              Acting on <strong>{target.fields.merchant || target.fields.category}</strong>{' '}
              ({formatMoney(target.fields.amount_cents)}), revision {target.rev}.
            </p>
          ) : (
            <p className="muted small">
              Add an expense and let it sync first - the other device can only edit
              something the server has seen.
            </p>
          )}

          {note && <p className="dev-note">{note}</p>}

          <dl className="dev-stats">
            <div>
              <dt>Device</dt>
              <dd>
                <code>{sync.deviceId.slice(0, 12)}</code>
              </dd>
            </div>
            <div>
              <dt>Pull cursor</dt>
              <dd>{sync.cursor}</dd>
            </div>
            <div>
              <dt>Queued</dt>
              <dd>{sync.pending}</dd>
            </div>
            <div>
              <dt>Conflicts</dt>
              <dd>{sync.conflicts}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="ghost danger-text"
            onClick={() => {
              if (confirm('Clear this device and re-pull everything from the server?')) {
                void engine.reset();
              }
            }}
          >
            Reset this device
          </button>
        </div>
      )}
    </section>
  );
}
