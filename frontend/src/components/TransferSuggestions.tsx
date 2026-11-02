import { useEffect, useState } from 'react';

import { bankEvents, fetchTransferSuggestions, type ExpenseBrief } from '../lib/bank';
import { formatDay, formatMoney } from '../lib/format';
import { TransferAction } from './TransferAction';

/**
 * Bank expenses that read like moving money - "e-Transfer", "TFR" - asked
 * about one by one. Moves between two connected accounts are left out without
 * asking; this catches the ones going to an account that isn't connected.
 * "It's spending" is remembered on this device.
 */

type Suggestion = ExpenseBrief & { description: string };

const dismissedKey = (userId: string) => `tally:not-transfers:${userId}`;
const SHOWN = 4;

function readDismissed(userId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissedKey(userId)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function TransferSuggestions({ userId }: { userId: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTransferSuggestions()
        .then((value) => {
          if (cancelled) return;
          setSuggestions(value.suggestions);
          setGone(new Set());
        })
        .catch(() => {
          /* offline: nothing to ask about */
        });
    void load();
    bankEvents.addEventListener('changed', load);
    return () => {
      cancelled = true;
      bankEvents.removeEventListener('changed', load);
    };
  }, []);

  const open = suggestions.filter((s) => !dismissed.has(s.entry_id) && !gone.has(s.entry_id));
  if (open.length === 0) return null;

  const dismiss = (entryId: string) => {
    const next = new Set(dismissed).add(entryId);
    setDismissed(next);
    try {
      localStorage.setItem(dismissedKey(userId), JSON.stringify([...next]));
    } catch {
      /* it'll be asked again next time */
    }
  };

  const visible = showAll ? open : open.slice(0, SHOWN);
  const total = open.reduce((sum, s) => sum + s.amount_cents, 0);

  return (
    <section className="suggest" aria-label="Possible transfers">
      <div className="suggest-head">
        <h3>Moving money, or spending?</h3>
        <p className="muted small">
          {open.length} bank {open.length === 1 ? 'charge reads' : 'charges read'} like a transfer (
          {formatMoney(total)}). If it went to another account of yours, it isn’t spending.
        </p>
      </div>
      <ul className="suggest-list">
        {visible.map((s) => (
          <li key={s.entry_id} className="suggest-item">
            <div className="suggest-text">
              <strong>{s.merchant || s.description}</strong>
              <small>
                {formatDay(s.occurred_on)}
                {s.bank ? ` · ${s.bank}` : ''}
              </small>
            </div>
            <span className="suggest-amount">{formatMoney(s.amount_cents)}</span>
            <div className="suggest-actions">
              <TransferAction
                entryId={s.entry_id}
                label="Not spending"
                className="primary small-button"
                onDone={() => setGone((prev) => new Set(prev).add(s.entry_id))}
              />
              <button type="button" className="ghost small-button" onClick={() => dismiss(s.entry_id)}>
                It’s spending
              </button>
            </div>
          </li>
        ))}
      </ul>
      {open.length > SHOWN && (
        <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${open.length}`}
        </button>
      )}
    </section>
  );
}
