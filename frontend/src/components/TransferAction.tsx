import { useState } from 'react';

import { engine } from '../engine';
import { announceBankChange, markAsTransfer, previewTransfer } from '../lib/bank';
import { formatMoney } from '../lib/format';

/**
 * "This expense is me moving my own money." Before a rule is made, the server
 * says what else reads the same way: an e-Transfer to yourself and one to a
 * friend can share a description, and only the person knows which is which.
 *
 * - Nothing else matches: it's taken out and a rule stops future ones.
 * - Others match: they choose all of them (and future ones), or just this one.
 *   Just this one is an ordinary delete, which works offline.
 */

type Step =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'choose'; count: number; total: number; pattern: string }
  | { kind: 'saving' };

export function TransferAction({
  entryId,
  label = 'Not spending',
  className = 'ghost',
  onDone,
}: {
  entryId: string;
  label?: string;
  className?: string;
  onDone?: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const all = async () => {
    setStep({ kind: 'saving' });
    try {
      await markAsTransfer(entryId);
      void engine.sync();
      announceBankChange();
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the server.');
      setStep({ kind: 'idle' });
    }
  };

  const justThis = async () => {
    await engine.deleteEntry(entryId);
    onDone?.();
  };

  const start = async () => {
    setError(null);
    setStep({ kind: 'checking' });
    try {
      const preview = await previewTransfer(entryId);
      if (preview.others.length === 0) {
        await all();
        return;
      }
      setStep({
        kind: 'choose',
        count: preview.others.length,
        total: preview.others_total_cents,
        pattern: preview.pattern,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the server.');
      setStep({ kind: 'idle' });
    }
  };

  if (step.kind === 'choose') {
    return (
      <div className="transfer-choice">
        <p>
          {step.count} other {step.count === 1 ? 'expense reads' : 'expenses read'} the same way
          (“{step.pattern}”, {formatMoney(step.total)}). Are they all money you moved to yourself?
        </p>
        <div className="transfer-choice-actions">
          <button type="button" className="primary" onClick={() => void all()}>
            Yes, all of them
          </button>
          <button type="button" className="ghost" onClick={() => void justThis()}>
            Only this one
          </button>
          <button type="button" className="ghost" onClick={() => setStep({ kind: 'idle' })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={className}
        disabled={step.kind !== 'idle'}
        onClick={() => void start()}
      >
        {step.kind === 'idle' ? label : 'Checking…'}
      </button>
      {error && <p className="form-error">{error}</p>}
    </>
  );
}
