import { useMemo, useState } from 'react';

import { formatMoney, formatMoneyWhole, todayISO } from '../lib/format';
import type { LocalEntry } from '../lib/types';
import { TransferSuggestions } from './TransferSuggestions';

/**
 * Where the money went, month by month. Worked out on the device from the
 * ledger, so it's there with no signal and counts typed-in and bank expenses
 * alike. Tap a category to see its biggest merchants.
 */

interface Category {
  name: string;
  total: number;
  count: number;
  merchants: { name: string; total: number; count: number }[];
}

function shiftMonth(month: string, by: number): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthName(month: string): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function shortMonthName(month: string): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long' });
}

function breakdown(entries: LocalEntry[], month: string): { total: number; categories: Category[] } {
  const byCategory = new Map<string, Category>();
  let total = 0;
  for (const entry of entries) {
    if (entry.deleted || !entry.fields.occurred_on.startsWith(month)) continue;
    const amount = entry.fields.amount_cents;
    total += amount;
    const name = entry.fields.category || 'other';
    const category = byCategory.get(name) ?? { name, total: 0, count: 0, merchants: [] };
    category.total += amount;
    category.count += 1;
    const merchantName = entry.fields.merchant || 'Unnamed';
    const merchant = category.merchants.find((m) => m.name === merchantName);
    if (merchant) {
      merchant.total += amount;
      merchant.count += 1;
    } else {
      category.merchants.push({ name: merchantName, total: amount, count: 1 });
    }
    byCategory.set(name, category);
  }
  const categories = [...byCategory.values()]
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  for (const category of categories) category.merchants.sort((a, b) => b.total - a.total);
  return { total, categories };
}

function Comparison({ now, before, month }: { now: number; before: number; month: string }) {
  if (before <= 0) return null;
  const diff = now - before;
  const pct = Math.round((Math.abs(diff) / before) * 100);
  const previous = shortMonthName(shiftMonth(month, -1));
  if (pct === 0) return <p className="hero-sub">About the same as {previous}</p>;
  return (
    <p className="hero-sub">
      {formatMoneyWhole(Math.abs(diff))} {diff > 0 ? 'more' : 'less'} than {previous} ({pct}%)
    </p>
  );
}

export function SpendingView({ entries, userId }: { entries: LocalEntry[]; userId: string }) {
  const thisMonth = todayISO().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [open, setOpen] = useState<string | null>(null);

  const earliest = useMemo(() => {
    let first = thisMonth;
    for (const entry of entries) {
      const m = entry.fields.occurred_on.slice(0, 7);
      if (!entry.deleted && m < first) first = m;
    }
    return first;
  }, [entries, thisMonth]);

  const current = useMemo(() => breakdown(entries, month), [entries, month]);
  const previous = useMemo(() => breakdown(entries, shiftMonth(month, -1)), [entries, month]);
  const largest = current.categories[0]?.total ?? 0;

  const go = (by: number) => {
    setMonth((m) => shiftMonth(m, by));
    setOpen(null);
  };

  return (
    <div className="view">
      <section className="hero" aria-label={`Spending in ${monthName(month)}`}>
        <div className="month-nav">
          <button type="button" className="ghost icon" onClick={() => go(-1)} disabled={month <= earliest}
            aria-label="Previous month">
            ‹
          </button>
          <p className="hero-label">{monthName(month)}</p>
          <button type="button" className="ghost icon" onClick={() => go(1)} disabled={month >= thisMonth}
            aria-label="Next month">
            ›
          </button>
        </div>
        <p className="hero-number">{formatMoney(current.total)}</p>
        <Comparison now={current.total} before={previous.total} month={month} />
      </section>

      <TransferSuggestions userId={userId} />

      {current.categories.length === 0 ? (
        <p className="empty muted">Nothing spent in {monthName(month)}.</p>
      ) : (
        <section className="group" aria-label="By category">
          <h3 className="group-head">
            <span>By category</span>
            <span className="muted small">share of the month</span>
          </h3>
          <ul className="card-list category-list">
            {current.categories.map((category) => {
              const share = current.total > 0 ? category.total / current.total : 0;
              const isOpen = open === category.name;
              return (
                <li key={category.name} className={`category ${isOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className="category-row"
                    onClick={() => setOpen(isOpen ? null : category.name)}
                    aria-expanded={isOpen}
                    title={`${category.name}: ${formatMoney(category.total)}, ${Math.round(share * 100)}% of the month, ${category.count} ${category.count === 1 ? 'expense' : 'expenses'}`}
                  >
                    <span className="category-top">
                      <span className="category-name">{category.name}</span>
                      <span className="category-amount">
                        {formatMoney(category.total)}
                        <small>{Math.round(share * 100)}%</small>
                      </span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <span className="meter-fill" style={{ width: `${(category.total / largest) * 100}%` }} />
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="merchant-list">
                      {category.merchants.slice(0, 6).map((merchant) => (
                        <li key={merchant.name}>
                          <span>
                            {merchant.name}
                            {merchant.count > 1 && <small className="muted"> ×{merchant.count}</small>}
                          </span>
                          <span>{formatMoney(merchant.total)}</span>
                        </li>
                      ))}
                      {category.merchants.length > 6 && (
                        <li className="muted">
                          <span>{category.merchants.length - 6} more</span>
                          <span>
                            {formatMoney(
                              category.merchants.slice(6).reduce((sum, m) => sum + m.total, 0),
                            )}
                          </span>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
