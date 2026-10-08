import { useState } from 'react';

import { engine } from '../engine';
import { displayValue, fieldLabel, timeAgo } from '../lib/format';
import type { ConflictRecord, FieldName, FieldPatch } from '../lib/types';

/**
 * Explicit conflict resolution.
 *
 * The rule this UI exists to enforce: when two versions of the same field
 * disagree, a person decides. Both values are shown side by side, labelled with
 * which device produced them, and nothing is applied until a button is pressed.
 */

const HEADLINES: Record<ConflictRecord['detail']['reason'], string> = {
  field_overlap: 'Edited in two places',
  update_vs_delete: 'You edited something that was deleted',
  delete_vs_update: 'You deleted something that was edited',
  create_exists: 'This entry already exists',
  diverged: 'This entry moved on without you',
  rejected: 'The server would not accept this change',
};

function fieldsInPlay(conflict: ConflictRecord): FieldName[] {
  const { detail } = conflict;
  const names = new Set<FieldName>([
    ...detail.overlapping_fields,
    ...detail.my_changed_fields,
  ]);
  // Only show rows where the two sides actually differ.
  return [...names].filter(
    (name) => conflict.my_fields[name] !== detail.server_fields[name],
  );
}

function ConflictCard({ conflict }: { conflict: ConflictRecord }) {
  const { detail } = conflict;
  const rows = fieldsInPlay(conflict);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>(() =>
    Object.fromEntries(rows.map((name) => [name, 'mine' as const])),
  );
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const applySelection = () =>
    run(async () => {
      const values: FieldPatch = {};
      for (const name of rows) {
        const source = choices[name] === 'theirs' ? detail.server_fields : conflict.my_fields;
        // Index assignment through a union of value types needs the cast.
        (values as Record<string, unknown>)[name] = source[name];
      }
      await engine.resolveConflict(conflict.id, { type: 'fields', values });
    });

  const keepMine = () => run(() => engine.resolveConflict(conflict.id, { type: 'mine' }));
  const keepTheirs = () => run(() => engine.resolveConflict(conflict.id, { type: 'theirs' }));

  const theirDevice = detail.server_updated_by || 'another device';
  const isDeleteCase =
    detail.reason === 'update_vs_delete' || detail.reason === 'delete_vs_update';

  return (
    <article className="conflict-card">
      <header>
        <h3>{HEADLINES[detail.reason] ?? 'Needs a decision'}</h3>
        <p className="conflict-why">{conflict.message}</p>
        <p className="muted small">
          Your version was made on this device; theirs came from{' '}
          <code>{theirDevice}</code> {timeAgo(detail.server_updated_at)}. Nothing has been
          overwritten.
        </p>
      </header>

      {detail.reason === 'update_vs_delete' && (
        <div className="conflict-body">
          <p>
            <code>{theirDevice}</code> deleted this entry while you were editing it.
          </p>
          <div className="conflict-actions">
            <button type="button" className="primary" onClick={keepMine} disabled={busy}>
              Bring it back with my edits
            </button>
            <button type="button" className="ghost" onClick={keepTheirs} disabled={busy}>
              Accept the deletion
            </button>
          </div>
        </div>
      )}

      {detail.reason === 'delete_vs_update' && (
        <div className="conflict-body">
          <p>
            You deleted this entry, but <code>{theirDevice}</code> changed{' '}
            {detail.overlapping_fields.map(fieldLabel).join(', ') || 'it'} afterwards.
          </p>
          <dl className="field-compare single">
            {detail.overlapping_fields.map((name) => (
              <div key={name} className="compare-row">
                <dt>{fieldLabel(name)}</dt>
                <dd>{displayValue(name, detail.server_fields)}</dd>
              </div>
            ))}
          </dl>
          <div className="conflict-actions">
            <button type="button" className="danger" onClick={keepMine} disabled={busy}>
              Delete it anyway
            </button>
            <button type="button" className="ghost" onClick={keepTheirs} disabled={busy}>
              Keep their version
            </button>
          </div>
        </div>
      )}

      {!isDeleteCase && (
        <div className="conflict-body">
          {rows.length > 0 ? (
            <>
              <div className="compare-head">
                <span />
                <span>Mine</span>
                <span>Theirs</span>
              </div>
              <ul className="field-compare">
                {rows.map((name) => (
                  <li key={name} className="compare-row">
                    <span className="compare-label">{fieldLabel(name)}</span>
                    <button
                      type="button"
                      className={`compare-option ${choices[name] === 'mine' ? 'is-chosen' : ''}`}
                      aria-pressed={choices[name] === 'mine'}
                      onClick={() => setChoices((prev) => ({ ...prev, [name]: 'mine' }))}
                    >
                      {displayValue(name, conflict.my_fields)}
                    </button>
                    <button
                      type="button"
                      className={`compare-option ${choices[name] === 'theirs' ? 'is-chosen' : ''}`}
                      aria-pressed={choices[name] === 'theirs'}
                      onClick={() => setChoices((prev) => ({ ...prev, [name]: 'theirs' }))}
                    >
                      {displayValue(name, detail.server_fields)}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="conflict-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={applySelection}
                  disabled={busy}
                >
                  Use what I picked
                </button>
                <button type="button" className="ghost" onClick={keepMine} disabled={busy}>
                  All mine
                </button>
                <button type="button" className="ghost" onClick={keepTheirs} disabled={busy}>
                  All theirs
                </button>
              </div>
            </>
          ) : (
            <div className="conflict-actions">
              <button type="button" className="primary" onClick={keepMine} disabled={busy}>
                Send my version again
              </button>
              <button type="button" className="ghost" onClick={keepTheirs} disabled={busy}>
                Discard my change
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function ConflictList({ conflicts }: { conflicts: ConflictRecord[] }) {
  if (conflicts.length === 0) return null;

  return (
    <section className="conflicts" aria-label="Conflicts">
      <h2 className="section-title attention">
        {conflicts.length} change{conflicts.length === 1 ? '' : 's'} need
        {conflicts.length === 1 ? 's' : ''} your decision
      </h2>
      {conflicts.map((conflict) => (
        <ConflictCard key={conflict.id} conflict={conflict} />
      ))}
    </section>
  );
}
