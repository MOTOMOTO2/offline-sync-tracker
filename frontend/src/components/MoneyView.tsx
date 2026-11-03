import { useBankData } from '../hooks/useBankData';
import { fetchBalances, type Account, type Balances } from '../lib/bank';
import { formatMoney, formatMoneyWhole } from '../lib/format';
import { Banks } from './Banks';
import { CreditScoreCard } from './CreditScoreCard';
import { Leftovers } from './Leftovers';
import { TransferRules } from './TransferRules';

/**
 * What you have against what you owe, from every connected account's balance
 * as of its bank's last sync. A credit card or loan's balance counts as owed;
 * everything else as yours.
 */

const GROUPS: { key: string; title: string; test: (a: Account) => boolean }[] = [
  { key: 'cash', title: 'Cash & savings', test: (a) => a.type === 'depository' },
  { key: 'invest', title: 'Investments', test: (a) => a.type === 'investment' || a.type === 'brokerage' },
  { key: 'credit', title: 'Credit cards', test: (a) => a.type === 'credit' },
  { key: 'loan', title: 'Loans', test: (a) => a.type === 'loan' },
  { key: 'other', title: 'Other', test: () => true },
];

function grouped(accounts: Account[]) {
  const left = [...accounts];
  return GROUPS.map((group) => {
    const members = left.filter(group.test);
    for (const member of members) left.splice(left.indexOf(member), 1);
    return { ...group, members, total: members.reduce((sum, a) => sum + a.current_cents, 0) };
  }).filter((group) => group.members.length > 0);
}

function asOf(accounts: Account[]): string | null {
  const times = accounts.map((a) => a.as_of).filter((t): t is string => Boolean(t));
  if (times.length === 0) return null;
  const oldest = new Date(times.sort()[0]!);
  return oldest.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function HaveOweBar({ have, owe }: { have: number; owe: number }) {
  const whole = Math.max(have, 0) + Math.max(owe, 0);
  if (whole <= 0) return null;
  const haveShare = Math.max(have, 0) / whole;
  const label =
    `You have ${formatMoney(have)} and owe ${formatMoney(owe)}: ` +
    `${Math.round(haveShare * 100)}% of the total is yours.`;
  return (
    <div className="split" role="img" aria-label={label}>
      <div className="split-bar">
        {have > 0 && (
          <span
            className="split-part split-have"
            style={{ flexGrow: haveShare }}
            title={`Have ${formatMoney(have)}`}
          />
        )}
        {owe > 0 && (
          <span
            className="split-part split-owe"
            style={{ flexGrow: 1 - haveShare }}
            title={`Owe ${formatMoney(owe)}`}
          />
        )}
      </div>
      <div className="legend" aria-hidden="true">
        <span>
          <i className="swatch split-have" /> Have
        </span>
        <span>
          <i className="swatch split-owe" /> Owe
        </span>
      </div>
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  const used =
    account.owed && account.limit_cents ? Math.min(account.current_cents / account.limit_cents, 1) : null;
  return (
    <li className="account-row">
      <span className="bank-text">
        <strong>{account.name}</strong>
        <small>
          {account.institution}
          {account.mask && ` ••${account.mask}`}
          {used !== null && ` · ${Math.round(used * 100)}% of ${formatMoneyWhole(account.limit_cents!)} limit`}
          {!account.owed &&
            account.available_cents !== null &&
            account.available_cents !== account.current_cents &&
            ` · ${formatMoney(account.available_cents)} available`}
        </small>
      </span>
      <span className={`account-balance ${account.owed ? 'is-owed' : ''}`}>
        {account.owed && account.current_cents > 0 ? '−' : ''}
        {formatMoney(Math.abs(account.current_cents))}
      </span>
    </li>
  );
}

export function MoneyView({ userId }: { userId: string }) {
  const { data, loading } = useBankData<Balances>('balances', userId, fetchBalances);
  const accounts = data?.accounts ?? [];
  const [main, ...others] = data?.totals ?? [];
  const updated = asOf(accounts);

  return (
    <div className="view">
      {main ? (
        <section className="hero" aria-label="Net worth">
          <p className="hero-label">Net worth</p>
          <p className={`hero-number ${main.net_cents < 0 ? 'is-negative' : ''}`}>
            {formatMoneyWhole(main.net_cents)}
            {data!.totals.length > 1 && <small> {main.currency}</small>}
          </p>
          <div className="stat-pair">
            <div className="stat">
              <span className="stat-label">
                <i className="swatch split-have" aria-hidden="true" /> You have
              </span>
              <span className="stat-value">{formatMoney(main.have_cents)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">
                <i className="swatch split-owe" aria-hidden="true" /> You owe
              </span>
              <span className="stat-value">{formatMoney(main.owe_cents)}</span>
            </div>
          </div>
          <HaveOweBar have={main.have_cents} owe={main.owe_cents} />
          {others.map((t) => (
            <p key={t.currency} className="muted small">
              Also {formatMoney(t.have_cents)} held and {formatMoney(t.owe_cents)} owed in {t.currency}.
            </p>
          ))}
          {updated && <p className="hero-foot">Balances as of {updated}</p>}
        </section>
      ) : (
        !loading && (
          <section className="hero hero-empty">
            <p className="hero-label">Net worth</p>
            <p className="muted">
              Connect a bank below and your balances show up here: what's in your accounts
              against what's on your cards and loans.
            </p>
          </section>
        )
      )}

      <Leftovers userId={userId} />

      <CreditScoreCard userId={userId} />

      {grouped(accounts).map((group) => (
        <section key={group.key} className="group" aria-label={group.title}>
          <h3 className="group-head">
            <span>{group.title}</span>
            <span className="group-total">{formatMoney(Math.abs(group.total))}</span>
          </h3>
          <ul className="card-list">
            {group.members.map((account) => (
              <AccountRow key={`${account.item_id}-${account.name}-${account.mask}`} account={account} />
            ))}
          </ul>
        </section>
      ))}

      <TransferRules />

      <Banks />
    </div>
  );
}
