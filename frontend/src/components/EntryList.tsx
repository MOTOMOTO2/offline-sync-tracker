import { useState } from 'react';

import { engine } from '../engine';
import { formatDay, formatMoney } from '../lib/format';
import type { LocalEntry } from '../lib/types';
import { EntryForm } from './EntryForm';

/** The log itself, grouped by the day the money was spent. */

function StatusBadge({ entry }: { entry: LocalEntry }) {
  if (entry.hasConflict) {
    return (
      <span className="badge badge-conflict" title="Needs your decision">
        conflict
      </span>
    );
  }
  if (entry.isNew) {
    return (
      <span className="badge badge-pending" title="Saved here, not sent yet">
        not sent
      </span>
    );
  }
  if (entry.pendingOps > 0) {
    return (
      <span
        className="badge badge-pending"
        title={`Edited here: ${entry.pendingFields.join(', ')}`}
      >
        queued
      </span>
    );
  }
  return (
    <span className="badge badge-synced" title={`Synced, revision ${entry.rev}`}>
      synced
    </span>
  );
}

function EntryRow({ entry }: { entry: LocalEntry }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="entry editing">
        <EntryForm entry={entry} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className={`entry ${entry.hasConflict ? 'has-conflict' : ''}`}>
      <button
        type="button"
        className="entry-main"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${entry.fields.merchant || entry.fields.category}`}
      >
        <span className="entry-text">
          <strong>{entry.fields.merchant || entry.fields.category}</strong>
          <small>
            {entry.fields.category}
            {entry.fields.note ? ` - ${entry.fields.note}` : ''}
          </small>
          {entry.fields.bank && (
            <small className="entry-bank" title="Seen on your bank statement">
              {entry.fields.bank}
            </small>
          )}
        </span>
        <span className="entry-right">
          <span className="entry-amount">{formatMoney(entry.fields.amount_cents)}</span>
          <StatusBadge entry={entry} />
        </span>
      </button>
      <button
        type="button"
        className="entry-delete"
        onClick={() => void engine.deleteEntry(entry.id)}
        aria-label="Delete entry"
        title="Delete"
      >
        &times;
      </button>
    </li>
  );
}

export function EntryList({ entries }: { entries: LocalEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="empty">
        <p>No expenses yet.</p>
        <p className="muted">
          Add one above. It saves on this device straight away, with or without a
          connection.
        </p>
      </div>
    );
  }

  const days = new Map<string, LocalEntry[]>();
  for (const entry of entries) {
    const bucket = days.get(entry.fields.occurred_on);
    if (bucket) bucket.push(entry);
    else days.set(entry.fields.occurred_on, [entry]);
  }

  return (
    <div className="entry-list">
      {[...days.entries()].map(([day, dayEntries]) => {
        const total = dayEntries.reduce((sum, entry) => sum + entry.fields.amount_cents, 0);
        return (
          <section key={day} className="day-group">
            <h3 className="day-header">
              <span>{formatDay(day)}</span>
              <span className="day-total">{formatMoney(total)}</span>
            </h3>
            <ul className="entries">
              {dayEntries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
