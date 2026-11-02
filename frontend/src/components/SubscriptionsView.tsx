import { useState } from 'react';

import { useBankData } from '../hooks/useBankData';
import {
  announceBankChange,
  fetchSubscriptions,
  removeSubscription,
  type RecurringStream,
  type Subscriptions,
} from '../lib/bank';
import { formatMoney, formatMoneyWhole, todayISO } from '../lib/format';
import { AddSubscription } from './AddSubscription';

/**
 * Repeating charges, by when they next renew. The list comes from the server:
 * Plaid's recurring detection when the account has it, otherwise the ledger's
 * own history (the same merchant at a steady price and gap).
 */

const FREQUENCY: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semi_monthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  annually: 'Yearly',
};

function daysUntil(iso: string): number {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const [ty = 1970, tm = 1, td = 1] = todayISO().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

function when(days: number): string {
  if (days < 0) return 'due';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function shortDate(iso: string): string {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function bucketOf(days: number | null): string {
  if (days === null) return 'Date unknown';
  if (days <= 7) return 'Next 7 days';
  if (days <= 31) return 'This month';
  return 'Later';
}

const BUCKETS = ['Next 7 days', 'This month', 'Later', 'Date unknown'];

function SubscriptionRow({ stream }: { stream: RecurringStream }) {
  const days = stream.next_date ? daysUntil(stream.next_date) : null;
  const name = stream.merchant || stream.category;
  return (
    <li className="sub-row">
      <span className="avatar" aria-hidden="true">
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span className="bank-text">
        <strong>{name}</strong>
        <small>
          {formatMoney(stream.amount_cents)} · {FREQUENCY[stream.frequency] ?? stream.frequency}
          {stream.frequency !== 'monthly' && ` · ≈${formatMoney(stream.monthly_cents)}/mo`}
          {stream.source === 'manual' && ' · added by you'}
        </small>
      </span>
      <span className="renews">
        {stream.next_date ? (
          <>
            <strong>{shortDate(stream.next_date)}</strong>
            <small className={days !== null && days <= 3 ? 'soon' : ''}>{when(days!)}</small>
          </>
        ) : (
          <small className="muted">last {shortDate(stream.last_date)}</small>
        )}
      </span>
      {stream.id !== undefined && (
        <button
          type="button"
          className="row-remove"
          aria-label={`Remove ${name}`}
          title="Remove"
          onClick={() => {
            if (window.confirm(`Remove ${name} from your subscriptions?`)) {
              void removeSubscription(stream.id!).then(announceBankChange).catch(() => {
                window.alert('Could not reach the server. Try again with a connection.');
              });
            }
          }}
        >
          &times;
        </button>
      )}
    </li>
  );
}

export function SubscriptionsView({ userId }: { userId: string }) {
  const { data, loading } = useBankData<Subscriptions>('subscriptions', userId, fetchSubscriptions);
  const [adding, setAdding] = useState(false);
  const streams = [...(data?.streams ?? [])].sort((a, b) =>
    (a.next_date ?? '9999') < (b.next_date ?? '9999') ? -1 : 1,
  );

  const groups = BUCKETS.map((bucket) => ({
    bucket,
    members: streams.filter(
      (s) => bucketOf(s.next_date ? daysUntil(s.next_date) : null) === bucket,
    ),
  })).filter((g) => g.members.length > 0);

  return (
    <div className="view">
      <section className="hero" aria-label="Subscriptions total">
        <p className="hero-label">Subscriptions</p>
        <p className="hero-number">
          {formatMoney(data?.monthly_total_cents ?? 0)}
          <small> / month</small>
        </p>
        {data && data.streams.length > 0 && (
          <p className="hero-sub">
            {data.streams.length} repeating {data.streams.length === 1 ? 'charge' : 'charges'} ·{' '}
            {formatMoneyWhole((data.monthly_total_cents ?? 0) * 12)} a year
          </p>
        )}
        {!adding && (
          <button type="button" className="hero-action" onClick={() => setAdding(true)}>
            + Add a subscription
          </button>
        )}
      </section>

      {adding && <AddSubscription onClose={() => setAdding(false)} />}

      {groups.map((group) => (
        <section key={group.bucket} className="group" aria-label={group.bucket}>
          <h3 className="group-head">
            <span>{group.bucket}</span>
            <span className="group-total">
              {formatMoney(group.members.reduce((sum, s) => sum + s.amount_cents, 0))}
            </span>
          </h3>
          <ul className="card-list">
            {group.members.map((stream) => (
              <SubscriptionRow key={`${stream.merchant}-${stream.frequency}`} stream={stream} />
            ))}
          </ul>
        </section>
      ))}

      {!loading && streams.length === 0 && (
        <p className="empty muted">
          No repeating charges found yet. They show up once a merchant has charged a steady
          amount at a steady gap - for monthly ones, about three months of history.
        </p>
      )}

      {data && streams.length > 0 && (
        <p className="muted small footnote">
          {data.source === 'plaid'
            ? 'Found by Plaid in your bank history.'
            : 'Spotted in your ledger: the same merchant at a steady price and a steady gap.'}{' '}
          Ones you add yourself replace a found one with the same name.{' '}
          Renewal dates are predictions from past charges; monthly figures for weekly and yearly
          charges are averages.
        </p>
      )}
    </div>
  );
}
