import { engine } from '../engine';
import { useEngineSnapshot } from '../hooks/useEngineSnapshot';
import { useNow } from '../hooks/useNow';
import { timeAgo } from '../lib/format';
import type { SyncState } from '../lib/types';

/**
 * The sync state, always on screen.
 *
 * In an offline-first app the user's main question is "is my stuff safe yet?",
 * and hiding the answer behind a settings screen is how people end up not
 * trusting the thing. Every state names what is happening and what is waiting.
 */

interface Presentation {
  tone: 'ok' | 'busy' | 'waiting' | 'offline' | 'attention' | 'bad';
  label: string;
  detail: string;
}

function present(sync: SyncState, pendingLabel: string): Presentation {
  switch (sync.status) {
    case 'syncing':
      return { tone: 'busy', label: 'Syncing', detail: pendingLabel || 'checking for changes' };
    case 'conflicts':
      return {
        tone: 'attention',
        label: `${sync.conflicts} need${sync.conflicts === 1 ? 's' : ''} your decision`,
        detail: 'nothing was overwritten',
      };
    case 'offline':
      return {
        tone: 'offline',
        label: 'Offline',
        detail: sync.pending > 0 ? `${pendingLabel}, will sync later` : 'everything is saved here',
      };
    case 'error':
      return { tone: 'bad', label: 'Sync failed', detail: sync.lastError ?? 'will retry' };
    case 'pending':
      return { tone: 'waiting', label: 'Waiting to sync', detail: pendingLabel };
    case 'idle':
    default:
      return {
        tone: 'ok',
        label: 'Up to date',
        detail: `synced ${timeAgo(sync.lastSyncedAt)}`,
      };
  }
}

export function SyncBar() {
  const { sync } = useEngineSnapshot();
  useNow(); // keeps "synced 3m ago" honest

  const pendingLabel =
    sync.pending > 0 ? `${sync.pending} change${sync.pending === 1 ? '' : 's'} queued` : '';
  const { tone, label, detail } = present(sync, pendingLabel);

  return (
    <div className={`sync-bar tone-${tone}`} role="status" aria-live="polite">
      <span className={`sync-dot ${sync.syncing ? 'is-busy' : ''}`} aria-hidden="true" />
      <span className="sync-text">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <button
        type="button"
        className="sync-now"
        onClick={() => void engine.sync()}
        disabled={sync.syncing}
      >
        {sync.syncing ? 'Syncing...' : 'Sync now'}
      </button>
    </div>
  );
}
