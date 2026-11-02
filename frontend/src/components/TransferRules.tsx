import { useEffect, useState } from 'react';

import { bankEvents, fetchTransferRules, removeTransferRule, type TransferRule } from '../lib/bank';

/**
 * Descriptions you've said are you moving your own money. Charges matching
 * them never count as spending. (Moves between two connected accounts are
 * spotted without a rule; these are for the rest.)
 */
export function TransferRules() {
  const [rules, setRules] = useState<TransferRule[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTransferRules()
        .then((value) => !cancelled && setRules(value.rules))
        .catch(() => {
          /* offline: the section stays hidden */
        });
    void load();
    bankEvents.addEventListener('changed', load);
    return () => {
      cancelled = true;
      bankEvents.removeEventListener('changed', load);
    };
  }, []);

  if (!rules || rules.length === 0) return null;

  const remove = async (rule: TransferRule) => {
    if (!window.confirm(`Count "${rule.label}" as spending again from now on?`)) return;
    try {
      await removeTransferRule(rule.id);
      setRules((prev) => prev?.filter((r) => r.id !== rule.id) ?? null);
    } catch {
      /* offline: try again later */
    }
  };

  return (
    <section className="group" aria-label="Not counted as spending">
      <h3 className="group-head">
        <span>Transfers, not spending</span>
      </h3>
      <ul className="card-list">
        {rules.map((rule) => (
          <li key={rule.id} className="account-row">
            <span className="bank-text">
              <strong>{rule.label}</strong>
              <small>Bank charges described “{rule.pattern}”</small>
            </span>
            <button type="button" className="ghost" onClick={() => void remove(rule)}>
              Count again
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small footnote">
        Money moving between two accounts you’ve connected is spotted on its own. Connect your
        other bank (Wealthsimple, say) and those transfers need no rule.
      </p>
    </section>
  );
}
