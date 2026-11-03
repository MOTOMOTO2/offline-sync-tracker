import { useEffect, useState } from 'react';

import { engine } from '../engine';
import { announceBankChange, bankEvents, type ExpenseBrief, fetchLeftovers, removeLeftovers } from '../lib/bank';
import { formatDay, formatMoney } from '../lib/format';

/**
 * Expenses brought in by a bank that has since been disconnected - the test
 * bank's made-up transactions, typically. Listed so they can go in one tap;
 * "Keep them" is remembered on this device.
 */

const keptKey = (userId: string) => `tally:kept-leftovers:${userId}`;

export function Leftovers({ userId }: { userId: string }) {
  const [data, setData] = useState<{ entries: ExpenseBrief[]; total_cents: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(() => {
    try {
      return localStorage.getItem(keptKey(userId)) ?? '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLeftovers()
        .then((value) => !cancelled && setData(value))
        .catch(() => {
          /* offline: nothing to show */
        });
    void load();
    bankEvents.addEventListener('changed', load);
    return () => {
      cancelled = true;
      bankEvents.removeEventListener('changed', load);
    };
  }, []);

  if (!data || data.entries.length === 0) return null;
  // "Keep them" holds until a different set of leftovers turns up.
  const signature = data.entries.map((e) => e.entry_id).sort().join(',');
  if (kept === signature) return null;

  const removeAll = async () => {
    setBusy(true);
    try {
      await removeLeftovers(data.entries.map((e) => e.entry_id));
      void engine.sync();
      announceBankChange();
    } finally {
      setBusy(false);
    }
  };

  const keep = () => {
    setKept(signature);
    try {
      localStorage.setItem(keptKey(userId), signature);
    } catch {
      /* asked again next time */
    }
  };

  return (
    <section className="suggest" aria-label="Expenses from disconnected banks">
      <div className="suggest-head">
        <h3>Expenses from a disconnected bank</h3>
        <p className="muted small">
          {data.entries.length} {data.entries.length === 1 ? 'expense' : 'expenses'} (
          {formatMoney(data.total_cents)}) came from a bank that’s no longer connected — the test
          bank, if you tried one. They still count towards your spending.
        </p>
      </div>
      <button type="button" className="link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide them' : 'See them'}
      </button>
      {open && (
        <ul className="merchant-list leftover-list">
          {data.entries.map((e) => (
            <li key={e.entry_id}>
              <span>
                {e.merchant || 'Unnamed'} <small className="muted">· {formatDay(e.occurred_on)}</small>
              </span>
              <span>{formatMoney(e.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="suggest-actions">
        <button type="button" className="primary small-button" disabled={busy} onClick={() => void removeAll()}>
          {busy ? 'Removing…' : `Remove all ${data.entries.length}`}
        </button>
        <button type="button" className="ghost small-button" onClick={keep}>
          Keep them
        </button>
      </div>
    </section>
  );
}
