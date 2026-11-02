import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { Banks } from './components/Banks';
import { ConflictList } from './components/ConflictList';
import { DevPanel } from './components/DevPanel';
import { EntryForm } from './components/EntryForm';
import { EntryList } from './components/EntryList';
import { InstallBanner, UpdateToast } from './components/InstallBanner';
import { SignIn } from './components/SignIn';
import { SyncBar } from './components/SyncBar';
import { bootstrap, engine, forgetThisDevice } from './engine';
import { useEngineSnapshot } from './hooks/useEngineSnapshot';
import { authConfigured, currentSession, onSessionChange, supabase } from './lib/auth';
import { forgetSubscriptions } from './lib/bank';
import { formatMoney, todayISO } from './lib/format';
import { monthTotal } from './lib/materialize';

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; session: Session };

function Boot({ message }: { message: string }) {
  return (
    <div className="boot">
      <img src="/icons/logo.svg" alt="" width="48" height="48" />
      <p>{message}</p>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    const apply = (session: Session | null) =>
      setAuth(session ? { status: 'signed-in', session } : { status: 'signed-out' });
    void currentSession().then(apply);
    return onSessionChange(apply);
  }, []);

  if (!authConfigured) {
    return <Boot message="This build has no Supabase project set (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)." />;
  }
  if (auth.status === 'loading') return <Boot message="Opening your ledger..." />;
  if (auth.status === 'signed-out') return <SignIn />;

  const { user } = auth.session;
  // Keyed by account, so switching accounts can never show the last one's data.
  return <Ledger key={user.id} userId={user.id} email={user.email ?? ''} />;
}

function Ledger({ userId, email }: { userId: string; email: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void bootstrap(userId).finally(() => setReady(true));
  }, [userId]);

  if (!ready) return <Boot message="Opening your ledger..." />;
  return <LedgerView userId={userId} email={email} />;
}

function LedgerView({ userId, email }: { userId: string; email: string }) {
  const snapshot = useEngineSnapshot();

  const signOut = async () => {
    const { pending } = engine.getSnapshot().sync;
    if (
      pending > 0 &&
      !window.confirm(
        `${pending} ${pending === 1 ? 'change has' : 'changes have'} not synced yet, and signing out ` +
          'deletes this device’s copy. Sign out anyway?',
      )
    ) {
      return;
    }
    await forgetThisDevice();
    forgetSubscriptions(userId);
    // 'local' works with no signal: it ends the session on this device only.
    await supabase?.auth.signOut({ scope: 'local' });
    window.location.reload();
  };

  const month = todayISO().slice(0, 7);
  const total = monthTotal(snapshot.entries, month);

  return (
    <div className="app">
      <header className="app-bar">
        <img src="/icons/logo.svg" alt="" width="28" height="28" />
        <h1>Tally</h1>
        <span className="month-total" title="Spent this month">
          {formatMoney(total)}
          <small>this month</small>
        </span>
      </header>

      <SyncBar />
      <UpdateToast />

      <main>
        <InstallBanner />

        <section className="composer" aria-label="Add an expense">
          <EntryForm />
        </section>

        <ConflictList conflicts={snapshot.conflicts} />

        <section aria-label="Expenses">
          <EntryList entries={snapshot.visible} />
        </section>

        <Banks userId={userId} />

        <DevPanel entries={snapshot.entries} />
      </main>

      <footer className="app-footer">
        <p>
          Everything is stored on this device first. Syncing is something that happens
          afterwards, when there is a connection.
        </p>
        <p className="account">
          Signed in as {email}.{' '}
          <button type="button" className="link" onClick={signOut}>
            Sign out
          </button>
        </p>
      </footer>
    </div>
  );
}
