import { useState } from 'react';

import { engine } from '../engine';
import { CATEGORIES } from '../lib/fields';
import { parseMoney, todayISO } from '../lib/format';
import type { Fields, LocalEntry } from '../lib/types';
import { TransferAction } from './TransferAction';

/**
 * Add or edit an expense.
 *
 * Submitting writes to the outbox and returns - there is no spinner and no
 * failure path here, because nothing about saving depends on the network.
 */

interface Props {
  /** Present when editing an existing entry. */
  entry?: LocalEntry;
  onDone?: () => void;
}

function initialAmount(entry?: LocalEntry): string {
  if (!entry) return '';
  return (entry.fields.amount_cents / 100).toFixed(2);
}

export function EntryForm({ entry, onDone }: Props) {
  const editing = Boolean(entry);
  const [amount, setAmount] = useState(() => initialAmount(entry));
  const [merchant, setMerchant] = useState(entry?.fields.merchant ?? '');
  const [category, setCategory] = useState(entry?.fields.category ?? 'groceries');
  const [occurredOn, setOccurredOn] = useState(entry?.fields.occurred_on ?? todayISO());
  const [note, setNote] = useState(entry?.fields.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setAmount('');
    setMerchant('');
    setNote('');
    setOccurredOn(todayISO());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cents = parseMoney(amount);
    if (cents === null) {
      setError('Enter an amount like 12.50');
      return;
    }
    setError(null);

    const fields: Partial<Fields> = {
      amount_cents: cents,
      merchant: merchant.trim(),
      category,
      occurred_on: occurredOn,
      note: note.trim(),
    };

    if (entry) {
      // Only send what actually moved, so unrelated fields cannot collide.
      const patch: Partial<Fields> = {};
      for (const [key, value] of Object.entries(fields) as [keyof Fields, never][]) {
        if (entry.fields[key] !== value) patch[key] = value;
      }
      await engine.updateEntry(entry.id, patch);
    } else {
      await engine.addEntry(fields);
      reset();
    }
    onDone?.();
  };

  return (
    <form className="entry-form" onSubmit={submit}>
      <div className="amount-row">
        <span className="currency" aria-hidden="true">
          $
        </span>
        <input
          className="amount-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          aria-label="Amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <input
          className="merchant-input"
          placeholder="Where?"
          aria-label="Merchant"
          maxLength={80}
          value={merchant}
          onChange={(event) => setMerchant(event.target.value)}
        />
      </div>

      <div className="chips" role="radiogroup" aria-label="Category">
        {CATEGORIES.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={category === name}
            className={`chip ${category === name ? 'is-selected' : ''}`}
            onClick={() => setCategory(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="detail-row">
        <label className="field">
          <span>Date</span>
          <input
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value || todayISO())}
          />
        </label>
        <label className="field grow">
          <span>Note</span>
          <input
            placeholder="optional"
            maxLength={280}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="form-actions">
        <button type="submit" className="primary">
          {editing ? 'Save changes' : 'Add expense'}
        </button>
        {editing && (
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>

      {entry?.fields.bank && !entry.isNew && (
        <TransferAction
          entryId={entry.id}
          label="Not spending: I moved this to my own account"
          className="link transfer-link"
          onDone={onDone}
        />
      )}
    </form>
  );
}
