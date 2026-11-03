import { useState } from 'react';

import { announceBankChange } from '../lib/bank';
import { type Budget, removeBudget, saveBudget } from '../lib/budgets';
import { CATEGORIES } from '../lib/fields';
import { formatMoney, parseMoney } from '../lib/format';

/**
 * Monthly limits per category. Typical spending (the average of the last three
 * months) is shown beside each, as a starting point. Leave one blank for no
 * budget. Needs a connection: budgets live on the server, which sends alerts.
 */

export function BudgetEditor({
  budgets,
  typical,
  onClose,
}: {
  budgets: Budget[];
  typical: Map<string, number>;
  onClose: () => void;
}) {
  const current = new Map(budgets.map((b) => [b.category, b.amount_cents]));
  const categories = [...new Set([...CATEGORIES, ...current.keys(), ...typical.keys()])];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      categories.map((c) => [c, current.has(c) ? (current.get(c)! / 100).toFixed(0) : '']),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      for (const category of categories) {
        const raw = (values[category] ?? '').trim();
        const cents = raw ? parseMoney(raw) : null;
        if (raw && (cents === null || cents <= 0)) {
          throw new Error(`“${raw}” isn’t an amount for ${category}.`);
        }
        if (cents && cents !== current.get(category)) await saveBudget(category, cents);
        if (!raw && current.has(category)) await removeBudget(category);
      }
      announceBankChange();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save. Try again with a connection.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="panel budget-editor" onSubmit={save}>
      <div className="panel-head">
        <h2 className="section-title">Monthly budgets</h2>
      </div>
      <p className="muted small">
        Leave a category blank for no budget. You’ll get a notification at 80% and when you go over.
      </p>
      <ul className="budget-fields">
        {categories.map((category) => (
          <li key={category}>
            <label htmlFor={`budget-${category}`}>
              <span className="category-name">{category}</span>
              {typical.get(category) ? (
                <small className="muted">usually {formatMoney(typical.get(category)!)}</small>
              ) : null}
            </label>
            <span className="budget-input">
              <span aria-hidden="true">$</span>
              <input
                id={`budget-${category}`}
                inputMode="decimal"
                placeholder="—"
                value={values[category] ?? ''}
                onChange={(event) => setValues((v) => ({ ...v, [category]: event.target.value }))}
              />
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save budgets'}
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
