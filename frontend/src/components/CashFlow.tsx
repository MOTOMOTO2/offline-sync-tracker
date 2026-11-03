import { useMemo, useState } from 'react';

import { useBankData } from '../hooks/useBankData';
import { fetchMoneyIn, type MoneyIn } from '../lib/bank';
import { formatMoney, formatMoneyWhole } from '../lib/format';
import type { LocalEntry } from '../lib/types';

/**
 * Money in against money out, month by month. Out is the ledger (so it
 * matches the Spending tab, typed-in expenses included); in comes from the
 * banks: income counts, other money arriving (a friend paying you back, a
 * refund) is shown but not counted, and moves between your own accounts are
 * left out on the server.
 */

function shiftMonth(month: string, by: number): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  const date = new Date(y, m - 1 + by, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string, style: 'short' | 'long' = 'short'): string {
  const [y = 1970, m = 1] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: style });
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

interface MonthFlow {
  month: string;
  income: number;
  other: number;
  out: number;
}

function Chart({ months, selected }: { months: MonthFlow[]; selected: string }) {
  const width = 320;
  const height = 132;
  const pad = { top: 8, bottom: 22, left: 4, right: 4 };
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.out]));
  const band = (width - pad.left - pad.right) / months.length;
  const bar = Math.min(14, (band - 10) / 2);
  const plot = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plot - (v / max) * plot;

  return (
    <svg
      className="flow-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={months
        .map((m) => `${monthLabel(m.month, 'long')}: in ${formatMoneyWhole(m.income)}, out ${formatMoneyWhole(m.out)}`)
        .join('; ')}
    >
      <line className="flow-base" x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} />
      {months.map((m, i) => {
        const center = pad.left + band * i + band / 2;
        const bars = [
          { cls: 'flow-in', value: m.income, x: center - bar - 1, label: 'In' },
          { cls: 'flow-out', value: m.out, x: center + 1, label: 'Out' },
        ];
        return (
          <g key={m.month} className={m.month === selected ? 'is-selected' : ''}>
            {bars.map((b) => {
              const top = y(b.value);
              const h = Math.max(y(0) - top, b.value > 0 ? 2 : 0);
              const r = Math.min(4, h / 2, bar / 2);
              // Rounded at the data end, square on the baseline.
              const d = `M${b.x},${y(0)} V${y(0) - h + r} Q${b.x},${y(0) - h} ${b.x + r},${y(0) - h} H${b.x + bar - r} Q${b.x + bar},${y(0) - h} ${b.x + bar},${y(0) - h + r} V${y(0)} Z`;
              return (
                <path key={b.cls} className={b.cls} d={d}>
                  <title>
                    {monthLabel(m.month, 'long')} · {b.label} {formatMoney(b.value)}
                  </title>
                </path>
              );
            })}
            {/* The whole month is the hover target, not just the thin bars. */}
            <rect className="flow-hit" x={pad.left + band * i} y={pad.top} width={band} height={plot}>
              <title>
                {monthLabel(m.month, 'long')}: in {formatMoney(m.income)}, out {formatMoney(m.out)}
              </title>
            </rect>
            <text className="flow-label" x={center} y={height - 6} textAnchor="middle">
              {monthLabel(m.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function CashFlow({ entries, month, userId }: { entries: LocalEntry[]; month: string; userId: string }) {
  const { data } = useBankData<MoneyIn>('moneyIn', userId, fetchMoneyIn);
  const [showSources, setShowSources] = useState(false);

  const months = useMemo(() => {
    const list: MonthFlow[] = [];
    for (let i = 5; i >= 0; i -= 1) list.push({ month: shiftMonth(month, -i), income: 0, other: 0, out: 0 });
    const byMonth = new Map(list.map((m) => [m.month, m]));
    for (const entry of entries) {
      if (entry.deleted) continue;
      const m = byMonth.get(entry.fields.occurred_on.slice(0, 7));
      if (m) m.out += entry.fields.amount_cents;
    }
    for (const item of data?.items ?? []) {
      const m = byMonth.get(item.on.slice(0, 7));
      if (!m) continue;
      if (item.kind === 'income') m.income += item.amount_cents;
      else m.other += item.amount_cents;
    }
    return list;
  }, [entries, data, month]);

  if (!data || data.items.length === 0) return null;

  const current = months[months.length - 1]!;
  const saved = current.income - current.out;
  const rate = current.income > 0 ? Math.round((saved / current.income) * 100) : null;
  const sources = (data.items ?? []).filter((i) => i.on.startsWith(month));

  return (
    <section className="panel flow" aria-label="Money in and out">
      <div className="panel-head">
        <h2 className="section-title">Money in &amp; out</h2>
        <div className="legend" aria-hidden="true">
          <span>
            <i className="swatch flow-in" /> In
          </span>
          <span>
            <i className="swatch flow-out" /> Out
          </span>
        </div>
      </div>

      <div className="flow-stats">
        <div className="stat">
          <span className="stat-label">In</span>
          <span className="stat-value" title={formatMoney(current.income)}>
            {formatMoneyWhole(current.income)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Out</span>
          <span className="stat-value" title={formatMoney(current.out)}>
            {formatMoneyWhole(current.out)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{saved >= 0 ? 'Saved' : 'Overspent'}</span>
          <span className="stat-value" title={formatMoney(Math.abs(saved))}>
            {formatMoneyWhole(Math.abs(saved))}
            {rate !== null && saved > 0 && <small> {rate}%</small>}
          </span>
        </div>
      </div>

      <Chart months={months} selected={month} />

      {current.other > 0 && (
        <p className="muted small">
          Also {formatMoney(current.other)} other money in (refunds, people paying you back). Not
          counted as income.
        </p>
      )}

      {sources.length > 0 && (
        <>
          <button type="button" className="link" onClick={() => setShowSources((v) => !v)}>
            {showSources ? 'Hide where it came from' : `Where ${monthLabel(month, 'long')}’s money came from`}
          </button>
          {showSources && (
            <ul className="merchant-list flow-sources">
              {sources.map((s, i) => (
                <li key={`${s.on}-${i}`}>
                  <span>
                    {titleCase(s.description) || 'Deposit'}
                    {s.kind === 'other' && <small className="muted"> · not income</small>}
                  </span>
                  <span>{formatMoney(s.amount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
