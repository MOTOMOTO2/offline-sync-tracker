import { useCallback, useEffect, useState } from 'react';

import { engine } from '../engine';
import { changedAnything } from '../hooks/useBankSync';
import {
  announceBankChange,
  bankStatus,
  disconnectBank,
  type BankItem,
  type BankStatus,
  type Imported,
  type LinkOutcome,
  openLink,
  refreshBanks,
  resumeLinkAfterRedirect,
} from '../lib/bank';

/**
 * Connecting and disconnecting banks. Their transactions arrive as ordinary
 * entries and their balances show on the Money tab; checking for new ones on
 * open is useBankSync's job.
 */

function summarise(imported: Imported | null): string {
  if (!imported) return 'Connected. Transactions will appear as the bank sends them.';
  const parts = [
    imported.added && `${imported.added} new`,
    imported.matched && `${imported.matched} matched to expenses you'd entered`,
  ].filter(Boolean);
  return parts.length ? `Brought in ${parts.join(', ')}.` : 'Connected. Nothing new yet.';
}

function accountCount(item: BankItem): string {
  const n = item.accounts.length;
  return n ? `${n} ${n === 1 ? 'account' : 'accounts'} · ` : '';
}

function lastSynced(item: BankItem): string {
  if (!item.last_synced_at) return 'Not checked yet';
  const when = new Date(item.last_synced_at);
  return `Checked ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

export function Banks() {
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const handleOutcome = useCallback(async (outcome: Promise<LinkOutcome>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await outcome;
      if (result.status === 'connected') {
        setNote(summarise(result.imported));
        if (changedAnything(result.imported)) void engine.sync();
      } else if (result.status === 'reconnected') {
        setNote('Signed back in.');
        void engine.sync();
      }
      setStatus(await bankStatus());
      announceBankChange();
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    bankStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
      })
      .catch(() => {
        /* offline: the panel stays hidden until there's a connection */
      });
    const resumed = resumeLinkAfterRedirect();
    if (resumed) void handleOutcome(resumed);
    return () => {
      cancelled = true;
    };
  }, [handleOutcome]);

  if (!status?.configured) return null;

  const checkNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await refreshBanks(true);
      setStatus((prev) => (prev ? { ...prev, items: result.items } : prev));
      if (changedAnything(result.imported)) void engine.sync();
      announceBankChange();
      setNote(changedAnything(result.imported) ? summarise(result.imported) : 'Up to date.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not reach the bank.');
    } finally {
      setBusy(false);
    }
  };

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
      announceBankChange();
      setNote(`${item.institution} disconnected.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Connected banks">
      <div className="panel-head">
        <h2 className="section-title">Connected banks</h2>
        {status.environment === 'sandbox' && <span className="badge badge-pending">test banks</span>}
      </div>

      {status.items.length === 0 ? (
        <p className="muted small">
          Connect a bank and its spending comes in on its own, with balances here. Expenses
          you've already typed in are matched, not counted twice.
        </p>
      ) : (
        <ul className="bank-list">
          {status.items.map((item) => (
            <li key={item.item_id} className="bank-item">
              <span className="bank-text">
                <strong>{item.institution}</strong>
                <small className={item.status === 'ok' ? '' : 'warn'}>
                  {item.status === 'ok' && `${accountCount(item)}${lastSynced(item)}`}
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
          <button type="button" className="ghost" disabled={busy} onClick={() => void checkNow()}>
            Check now
          </button>
        )}
      </div>
      {note && <p className="form-notice">{note}</p>}
    </section>
  );
}
