import { useState } from 'react';

import { useBankData } from '../hooks/useBankData';
import { announceBankChange } from '../lib/bank';
import {
  addCreditScore,
  band,
  type CreditData,
  type CreditScore,
  fetchCredit,
  MAX_SCORE,
  MIN_SCORE,
  removeCreditScore,
} from '../lib/credit';
import { formatDay, formatMoney, todayISO } from '../lib/format';

/**
 * Your credit score as you last checked it, how it's moved, and how much of
 * your cards' limits you're using. Banks don't share scores through Plaid, so
 * they're entered by hand: Scotiabank's app, Borrowell and Credit Karma all
 * show one for free.
 */

const SOURCES = ['TransUnion', 'Equifax', 'Other'];
// Utilisation above this starts to cost points.
const GOOD_UTILIZATION = 0.3;

function shortDate(iso: string): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function History({ scores }: { scores: CreditScore[] }) {
  const width = 320;
  const height = 96;
  const pad = { top: 12, right: 12, bottom: 20, left: 12 };
  const values = scores.map((s) => s.score);
  const lo = Math.min(...values) - 15;
  const hi = Math.max(...values) + 15;
  const x = (i: number) => pad.left + (i / (scores.length - 1)) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * (height - pad.top - pad.bottom);
  const path = scores.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.score).toFixed(1)}`).join(' ');
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;

  return (
    <svg
      className="score-history"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Credit score from ${first.score} on ${formatDay(first.on)} to ${last.score} on ${formatDay(last.on)}`}
    >
      <line className="score-baseline" x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} />
      <path className="score-line" d={path} />
      {scores.map((s, i) => (
        <g key={s.id}>
          {/* A bigger, invisible target than the dot, for hover and tap. */}
          <circle className="score-hit" cx={x(i)} cy={y(s.score)} r={14}>
            <title>
              {s.score} on {formatDay(s.on)}
              {s.source ? ` (${s.source})` : ''}
            </title>
          </circle>
          <circle className="score-dot" cx={x(i)} cy={y(s.score)} r={4} />
        </g>
      ))}
      <text className="score-axis" x={pad.left} y={height - 4}>
        {shortDate(first.on)}
      </text>
      <text className="score-axis" x={width - pad.right} y={height - 4} textAnchor="end">
        {shortDate(last.on)}
      </text>
      <text className="score-axis end-label" x={x(scores.length - 1) - 8} y={y(last.score) - 8} textAnchor="end">
        {last.score}
      </text>
    </svg>
  );
}

function AddScore({ onClose }: { onClose: () => void }) {
  const [score, setScore] = useState('');
  const [on, setOn] = useState(todayISO());
  const [source, setSource] = useState(SOURCES[0]!);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(score);
    if (!Number.isInteger(value) || value < MIN_SCORE || value > MAX_SCORE) {
      setError(`A score is a whole number from ${MIN_SCORE} to ${MAX_SCORE}.`);
      return;
    }
    try {
      await addCreditScore(value, on, source);
      announceBankChange();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the server.');
    }
  };

  return (
    <form className="score-form" onSubmit={submit}>
      <div className="detail-row">
        <label className="field">
          <span>Score</span>
          <input inputMode="numeric" placeholder="e.g. 742" value={score} onChange={(e) => setScore(e.target.value)} />
        </label>
        <label className="field grow">
          <span>Checked on</span>
          <input type="date" value={on} max={todayISO()} onChange={(e) => setOn(e.target.value || todayISO())} />
        </label>
      </div>
      <label className="field">
        <span>From</span>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary">
          Save score
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CreditScoreCard({ userId }: { userId: string }) {
  const { data } = useBankData<CreditData>('credit', userId, fetchCredit);
  const [adding, setAdding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const scores = data?.scores ?? [];
  const latest = scores[scores.length - 1];
  const before = scores[scores.length - 2];
  const util = data?.utilization ?? null;

  const remove = async (s: CreditScore) => {
    if (!window.confirm(`Delete the ${s.score} from ${formatDay(s.on)}?`)) return;
    try {
      await removeCreditScore(s.id);
      announceBankChange();
    } catch {
      window.alert('Could not reach the server.');
    }
  };

  return (
    <section className="panel credit" aria-label="Credit score">
      <div className="panel-head">
        <h2 className="section-title">Credit score</h2>
        {!adding && (
          <button type="button" className="link" onClick={() => setAdding(true)}>
            {latest ? 'Add a new score' : 'Add your score'}
          </button>
        )}
      </div>

      {latest ? (
        <>
          <div className="score-top">
            <span className="score-number">{latest.score}</span>
            <span className="score-meta">
              <strong>{band(latest.score)}</strong>
              <small>
                {before && latest.score !== before.score && (
                  <>
                    {latest.score > before.score ? '▲' : '▼'} {Math.abs(latest.score - before.score)} since{' '}
                    {shortDate(before.on)} ·{' '}
                  </>
                )}
                {latest.source ? `${latest.source}, ` : ''}checked {formatDay(latest.on)}
              </small>
            </span>
          </div>
          <div
            className="scale"
            role="img"
            aria-label={`${latest.score} on a scale from ${MIN_SCORE} to ${MAX_SCORE}`}
          >
            <span className="meter">
              <span
                className="meter-fill"
                style={{ width: `${((latest.score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)) * 100}%` }}
              />
            </span>
            <span className="scale-ends" aria-hidden="true">
              <span>{MIN_SCORE}</span>
              <span>{MAX_SCORE}</span>
            </span>
          </div>
          {scores.length >= 2 && <History scores={scores} />}
        </>
      ) : (
        !adding && (
          <p className="muted small">
            Banks don’t share credit scores through Plaid, so add yours when you check it. The
            Scotiabank app, Borrowell and Credit Karma all show it for free. Add one every month or
            so and you’ll see how it moves.
          </p>
        )
      )}

      {adding && <AddScore onClose={() => setAdding(false)} />}

      {util && (
        <div className="util">
          <div className="category-top">
            <span>Card utilisation</span>
            <span className="category-amount">{Math.round(util.ratio * 100)}%</span>
          </div>
          <span className="meter util-meter" aria-hidden="true">
            <span className="meter-fill" style={{ width: `${Math.min(util.ratio, 1) * 100}%` }} />
            <span className="util-mark" style={{ left: `${GOOD_UTILIZATION * 100}%` }} />
          </span>
          <small className="muted">
            {formatMoney(util.balance_cents)} of {formatMoney(util.limit_cents)} across {util.cards}{' '}
            {util.cards === 1 ? 'card' : 'cards'}.{' '}
            {util.ratio <= GOOD_UTILIZATION
              ? 'Under 30%, which helps your score.'
              : 'Over 30% tends to pull a score down; paying it below the line helps.'}
          </small>
        </div>
      )}

      {scores.length > 0 && (
        <button type="button" className="link" onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Hide past scores' : `All ${scores.length} ${scores.length === 1 ? 'score' : 'scores'}`}
        </button>
      )}
      {showHistory && (
        <ul className="card-list">
          {[...scores].reverse().map((s) => (
            <li key={s.id} className="account-row">
              <span className="bank-text">
                <strong>{s.score}</strong>
                <small>
                  {formatDay(s.on)}
                  {s.source ? ` · ${s.source}` : ''}
                </small>
              </span>
              <button type="button" className="row-remove" aria-label={`Delete ${s.score}`} onClick={() => void remove(s)}>
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
