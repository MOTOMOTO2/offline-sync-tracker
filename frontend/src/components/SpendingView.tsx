import { useMemo, useState } from 'react';

import { useBankData } from '../hooks/useBankData';
import { type Budget, fetchBudgets } from '../lib/budgets';
import { formatMoney, formatMoneyWhole, todayISO } from '../lib/format';
import type { LocalEntry } from '../lib/types';
import { BudgetEditor } from './BudgetEditor';
import { CashFlow } from './CashFlow';
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
  const [editingBudgets, setEditingBudgets] = useState(false);
  const { data: budgetData } = useBankData<{ budgets: Budget[] }>('budgets', userId, fetchBudgets);
  const budgets = useMemo(
    () => new Map((budgetData?.budgets ?? []).map((b) => [b.category, b.amount_cents])),
    [budgetData],
  );

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

  // Average of the three months before this one: a starting point for budgets.
  const typical = useMemo(() => {
    const sums = new Map<string, number>();
    for (let i = 1; i <= 3; i += 1) {
      for (const c of breakdown(entries, shiftMonth(thisMonth, -i)).categories) {
        sums.set(c.name, (sums.get(c.name) ?? 0) + c.total);
      }
    }
    return new Map([...sums].map(([name, total]) => [name, Math.round(total / 3)]));
  }, [entries, thisMonth]);

  // Budgeted categories with nothing spent yet still get a row.
  const rows = useMemo(() => {
    const list = [...current.categories];
    for (const [name] of budgets) {
      if (!list.some((c) => c.name === name)) list.push({ name, total: 0, count: 0, merchants: [] });
    }
    return list;
  }, [current, budgets]);
  const over = rows.filter((c) => budgets.has(c.name) && c.total > budgets.get(c.name)!).length;

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
        {budgets.size > 0 && (
          <p className="hero-sub">
            {over === 0
              ? `All ${budgets.size} budgets on track`
              : `${over} of ${budgets.size} ${budgets.size === 1 ? 'budget' : 'budgets'} over`}
          </p>
        )}
      </section>

      <TransferSuggestions userId={userId} />

      <CashFlow entries={entries} month={month} userId={userId} />

      {editingBudgets && (
        <BudgetEditor
          budgets={budgetData?.budgets ?? []}
          typical={typical}
          onClose={() => setEditingBudgets(false)}
        />
      )}

      {rows.length === 0 ? (
        <p className="empty muted">
          Nothing spent in {monthName(month)}.{' '}
          {!editingBudgets && (
            <button type="button" className="link" onClick={() => setEditingBudgets(true)}>
              Set budgets
            </button>
          )}
        </p>
      ) : (
        <section className="group" aria-label="By category">
          <h3 className="group-head">
            <span>By category</span>
            {!editingBudgets && (
              <button type="button" className="link group-action" onClick={() => setEditingBudgets(true)}>
                {budgets.size ? 'Edit budgets' : 'Set budgets'}
              </button>
            )}
          </h3>
          <ul className="card-list category-list">
            {rows.map((category) => {
              const share = current.total > 0 ? category.total / current.total : 0;
              const isOpen = open === category.name;
              const budget = budgets.get(category.name);
              const isOver = budget !== undefined && category.total > budget;
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
                        {budget === undefined ? (
                          <small>{Math.round(share * 100)}%</small>
                        ) : (
                          <small>of {formatMoney(budget)}</small>
                        )}
                      </span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <span
                        className={`meter-fill ${isOver ? 'is-over' : ''}`}
                        style={{
                          width: `${Math.min(1, budget !== undefined ? category.total / budget : category.total / (largest || 1)) * 100}%`,
                        }}
                      />
                    </span>
                    {budget !== undefined && (
                      <span className={`budget-note ${isOver ? 'is-over' : ''}`}>
                        {isOver
                          ? `⚠ Over by ${formatMoney(category.total - budget)}`
                          : `${formatMoney(budget - category.total)} left`}
                      </span>
                    )}
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
