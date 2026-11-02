import { useEffect, useState } from 'react';

import { pushState, type PushState, sendTest, turnOff, turnOn } from '../lib/push';

/** The switch for subscription notifications on this device. */

const EXPLAIN: Record<PushState, string> = {
  unsupported: 'This browser can’t show notifications. Chrome, Edge, Firefox and Safari can.',
  'needs-install':
    'On iPhone, notifications only work from the Home Screen: tap Share, then “Add to Home Screen”, and open Tally from there.',
  'not-configured': 'Notifications aren’t set up on the server yet.',
  denied: 'Notifications are blocked for Tally. Allow them in your browser or phone settings, then come back.',
  off: 'Get a heads-up the day before a subscription renews, and a note when it’s charged.',
  on: 'On for this device: the day before a renewal, and when a subscription is charged.',
};

export function NotificationSettings() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void pushState().then(setState).catch(() => setState('unsupported'));
  }, []);

  if (!state) return null;

  const run = async (action: () => Promise<PushState>) => {
    setBusy(true);
    setNote(null);
    try {
      setState(await action());
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'That didn’t work. Try again with a connection.');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      await sendTest();
      setNote('Sent. It should arrive in a few seconds.');
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'Could not send one.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel notify" aria-label="Notifications">
      <div className="notify-row">
        <span className="notify-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
        </span>
        <span className="bank-text">
          <strong>Renewal reminders</strong>
          <small>{EXPLAIN[state]}</small>
        </span>
        {(state === 'off' || state === 'on') && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={state === 'on'}
              disabled={busy}
              onChange={(event) => void run(event.target.checked ? turnOn : turnOff)}
              aria-label="Renewal reminders"
            />
            <span aria-hidden="true" />
          </label>
        )}
      </div>
      {state === 'on' && (
        <button type="button" className="link" disabled={busy} onClick={() => void test()}>
          Send a test notification
        </button>
      )}
      {note && <p className="form-notice">{note}</p>}
    </section>
  );
}
