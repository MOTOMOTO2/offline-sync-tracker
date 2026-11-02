import { useState } from 'react';

import { addSubscription, announceBankChange, type NewSubscription } from '../lib/bank';
import { CATEGORIES } from '../lib/fields';
import { parseMoney, todayISO } from '../lib/format';

/** A subscription the bank hasn't shown (yet), added by hand. Needs a connection. */

const FREQUENCIES: { value: NewSubscription['frequency']; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'annually', label: 'Yearly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'quarterly', label: 'Every 3 months' },
];

export function AddSubscription({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<NewSubscription['frequency']>('monthly');
  const [nextDate, setNextDate] = useState(todayISO());
  const [category, setCategory] = useState('fun');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cents = parseMoney(amount);
    if (!name.trim()) return setError('What is it called?');
    if (cents === null || cents <= 0) return setError('Enter a price like 16.49');
    setSaving(true);
    setError(null);
    try {
      await addSubscription({ name: name.trim(), amount_cents: cents, frequency, next_date: nextDate, category });
      announceBankChange();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the server. Try again with a connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="panel sub-form" onSubmit={submit}>
      <div className="panel-head">
        <h2 className="section-title">Add a subscription</h2>
      </div>
      <div className="amount-row">
        <span className="currency" aria-hidden="true">
          $
        </span>
        <input
          className="amount-input"
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Price"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <input
          className="merchant-input"
          placeholder="Name, e.g. Crave"
          aria-label="Name"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="detail-row">
        <label className="field">
          <span>How often</span>
          <select value={frequency} onChange={(event) => setFrequency(event.target.value as NewSubscription['frequency'])}>
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Next renewal</span>
          <input type="date" value={nextDate} onChange={(event) => setNextDate(event.target.value || todayISO())} />
        </label>
      </div>
      <label className="field">
        <span>Category</span>
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add subscription'}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
