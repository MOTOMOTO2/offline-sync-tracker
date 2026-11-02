import { useCallback, useEffect, useRef, useState } from 'react';

import { engine } from '../engine';
import {
  bankStatus,
  cachedSubscriptions,
  cacheSubscriptions,
  disconnectBank,
  fetchSubscriptions,
  type BankItem,
  type BankStatus,
  type Imported,
  type LinkOutcome,
  openLink,
  refreshBanks,
  resumeLinkAfterRedirect,
  type Subscriptions as SubscriptionsData,
} from '../lib/bank';
import { formatDay, formatMoney } from '../lib/format';

/**
 * Connected banks, and the repeating charges found in what they bring in.
 *
 * Bank transactions arrive as ordinary entries, so this panel never shows
 * them itself: it connects banks, nudges the server to check them when the
 * app opens, and pulls the ledger afterwards so new ones show up.
 */

// Opening the app twice in a minute shouldn't ask the bank twice.
const REFRESH_EVERY_MS = 2 * 60_000;

function summarise(imported: Imported | null): string {
  if (!imported) return 'Connected. Transactions will appear as the bank sends them.';
  const parts = [
    imported.added && `${imported.added} new`,
    imported.matched && `${imported.matched} matched to expenses you'd entered`,
  ].filter(Boolean);
  return parts.length ? `Brought in ${parts.join(', ')}.` : 'Connected. Nothing new yet.';
}

function itemTitle(item: BankItem): string {
  const masks = item.accounts.map((a) => `••${a.mask}`).filter((m) => m !== '••');
  return masks.length ? `${item.institution} ${masks.join(' ')}` : item.institution;
}

function lastSynced(item: BankItem): string {
  if (!item.last_synced_at) return 'not checked yet';
  const when = new Date(item.last_synced_at);
  return `checked ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

export function Banks({ userId }: { userId: string }) {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const lastRefresh = useRef(0);

  const afterImport = useCallback((imported: Imported | null) => {
    if (imported && imported.added + imported.matched + imported.updated + imported.removed > 0) {
      void engine.sync();
    }
  }, []);

  const refresh = useCallback(
    async (force = false) => {
      if (!force && Date.now() - lastRefresh.current < REFRESH_EVERY_MS) return;
      lastRefresh.current = Date.now();
      try {
        const result = await refreshBanks(force);
        setStatus((prev) => (prev ? { ...prev, items: result.items } : prev));
        afterImport(result.imported);
      } catch {
        /* offline, or the bank service is down: the next open tries again */
      }
    },
    [afterImport],
  );

  const handleOutcome = useCallback(
    async (outcome: Promise<LinkOutcome>) => {
      setBusy(true);
      setNote(null);
      try {
        const result = await outcome;
        if (result.status === 'connected') {
          setNote(summarise(result.imported));
          afterImport(result.imported);
        } else if (result.status === 'reconnected') {
          setNote('Signed back in.');
          void engine.sync();
        }
        setStatus(await bankStatus());
      } catch (error) {
        setNote(error instanceof Error ? error.message : 'Something went wrong.');
      } finally {
        setBusy(false);
      }
    },
    [afterImport],
  );

  useEffect(() => {
    let cancelled = false;
    bankStatus()
      .then((value) => {
        if (cancelled) return;
        setStatus(value);
        if (value.items.length > 0) void refresh();
      })
      .catch(() => {
        /* offline: the panel stays hidden until there's a connection */
      });

    const resumed = resumeLinkAfterRedirect();
    if (resumed) void handleOutcome(resumed);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, handleOutcome]);

  if (!status?.configured) return null;

  const remove = async (item: BankItem) => {
    if (
      !window.confirm(
        `Disconnect ${item.institution}? Expenses it already brought in stay in your ledger.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await disconnectBank(item.item_id);
      setStatus(await bankStatus());
      setNote(`${item.institution} disconnected.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel" aria-label="Banks">
        <div className="panel-head">
          <h2 className="section-title">Banks</h2>
          {status.environment === 'sandbox' && <span className="badge badge-pending">test banks</span>}
        </div>

        {status.items.length === 0 ? (
          <p className="muted small">
            Connect a bank and its card and account spending comes in on its own. Expenses
            you've already typed in are matched, not counted twice.
          </p>
        ) : (
          <ul className="bank-list">
            {status.items.map((item) => (
              <li key={item.item_id} className="bank-item">
                <span className="bank-text">
                  <strong>{itemTitle(item)}</strong>
                  <small className={item.status === 'ok' ? '' : 'warn'}>
                    {item.status === 'ok' && lastSynced(item)}
                    {item.status === 'login_required' && 'The bank wants you to sign in again.'}
                    {item.status === 'revoked' && 'Access was withdrawn at the bank.'}
                    {item.status === 'error' && (item.status_detail || 'The last check failed.')}
                  </small>
                </span>
                <span className="bank-actions">
                  {(item.status === 'login_required' || item.status === 'revoked') && (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void handleOutcome(openLink(item.item_id))}
                    >
                      Sign in
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void remove(item)}
                    aria-label={`Disconnect ${item.institution}`}
                  >
                    Disconnect
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="panel-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void handleOutcome(openLink())}
          >
            {busy ? 'Working…' : 'Connect a bank'}
          </button>
          {status.items.length > 0 && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void refresh(true)}>
              Check now
            </button>
          )}
        </div>
        {note && <p className="form-notice">{note}</p>}
      </section>

      <Subscriptions userId={userId} haveBanks={status.items.length > 0} />
    </>
  );
}

const FREQUENCY: Record<string, string> = {
  weekly: 'every week',
  biweekly: 'every 2 weeks',
  semi_monthly: 'twice a month',
  monthly: 'every month',
  quarterly: 'every 3 months',
  annually: 'every year',
};

function Subscriptions({ userId, haveBanks }: { userId: string; haveBanks: boolean }) {
  const [data, setData] = useState<SubscriptionsData | null>(() => cachedSubscriptions(userId));
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSubscriptions()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        cacheSubscriptions(userId, value);
      })
      .catch(() => {
        /* offline: the cached list stands */
      });
    return () => {
      cancelled = true;
    };
  }, [userId, haveBanks]);

  if (!data || data.streams.length === 0) return null;

  return (
    <section className="panel" aria-label="Subscriptions and repeating charges">
      <button
        type="button"
        className="panel-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>
          <span className="section-title">Subscriptions</span>
          <small className="muted">
            {data.streams.length} repeating {data.streams.length === 1 ? 'charge' : 'charges'}
          </small>
        </span>
        <span className="subs-total">
          {formatMoney(data.monthly_total_cents)}
          <small>a month</small>
        </span>
      </button>

      {open && (
        <>
          <ul className="subs-list">
            {data.streams.map((stream) => (
              <li key={`${stream.merchant}-${stream.frequency}`} className="sub-item">
                <span className="bank-text">
                  <strong>{stream.merchant || stream.category}</strong>
                  <small>
                    {formatMoney(stream.amount_cents)} {FREQUENCY[stream.frequency] ?? stream.frequency}
                    {stream.next_date ? ` · next ${formatDay(stream.next_date)}` : ''}
                  </small>
                </span>
                <span className="entry-amount">
                  {formatMoney(stream.monthly_cents)}
                  <small className="muted">/mo</small>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {data.source === 'plaid'
              ? 'Found by Plaid in your bank history.'
              : 'Spotted in your ledger: the same merchant at a steady price and a steady gap.'}{' '}
            Monthly amounts for weekly and yearly charges are averages.
          </p>
        </>
      )}
    </section>
  );
}
