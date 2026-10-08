import { useEffect, useState } from 'react';

import { ConflictList } from './components/ConflictList';
import { DevPanel } from './components/DevPanel';
import { EntryForm } from './components/EntryForm';
import { EntryList } from './components/EntryList';
import { InstallBanner, UpdateToast } from './components/InstallBanner';
import { SyncBar } from './components/SyncBar';
import { bootstrap } from './engine';
import { useEngineSnapshot } from './hooks/useEngineSnapshot';
import { formatMoney, todayISO } from './lib/format';
import { monthTotal } from './lib/materialize';

export default function App() {
  const snapshot = useEngineSnapshot();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    void bootstrap().finally(() => setBooting(false));
  }, []);

  if (booting && !snapshot.ready) {
    return (
      <div className="boot">
        <img src="/icons/logo.svg" alt="" width="48" height="48" />
        <p>Opening your ledger...</p>
      </div>
    );
  }

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

        <DevPanel entries={snapshot.entries} />
      </main>

      <footer className="app-footer">
        <p>
          Everything is stored on this device first. Syncing is something that happens
          afterwards, when there is a connection.
        </p>
      </footer>
    </div>
  );
}
