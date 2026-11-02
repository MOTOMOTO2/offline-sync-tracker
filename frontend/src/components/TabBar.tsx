/**
 * The four tabs, along the bottom where a thumb reaches them. The last tab
 * chosen is remembered on this device; a bank sign-in returning from its own
 * site lands on Money, where Link picks up again.
 */

export type Tab = 'expenses' | 'spending' | 'subscriptions' | 'money';

const TABS: Tab[] = ['expenses', 'spending', 'subscriptions', 'money'];
const STORAGE_KEY = 'tally:tab';

export function initialTab(): Tab {
  if (new URLSearchParams(window.location.search).has('oauth_state_id')) return 'money';
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Tab | null;
    if (saved && TABS.includes(saved)) return saved;
  } catch {
    /* storage blocked: start on expenses */
  }
  return 'expenses';
}

export function rememberTab(tab: Tab): void {
  try {
    localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    /* it'll just open on the default next time */
  }
}

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const ICONS: Record<Tab, React.ReactNode> = {
  expenses: (
    <svg {...ICON_PROPS}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  spending: (
    <svg {...ICON_PROPS}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  subscriptions: (
    <svg {...ICON_PROPS}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v4h-4" />
      <path d="M12 8v4l2.5 2" />
    </svg>
  ),
  money: (
    <svg {...ICON_PROPS}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M16 15h2" />
    </svg>
  ),
};

const LABELS: Record<Tab, string> = {
  expenses: 'Expenses',
  spending: 'Spending',
  subscriptions: 'Subscriptions',
  money: 'Money',
};

export function TabBar({
  tab,
  onChange,
  conflicts,
}: {
  tab: Tab;
  onChange: (tab: Tab) => void;
  conflicts: number;
}) {
  return (
    <nav className="tab-bar" aria-label="Sections">
      {TABS.map((name) => (
        <button
          key={name}
          type="button"
          className={`tab ${tab === name ? 'is-active' : ''}`}
          aria-current={tab === name ? 'page' : undefined}
          onClick={() => onChange(name)}
        >
          {ICONS[name]}
          <span>{LABELS[name]}</span>
          {name === 'expenses' && conflicts > 0 && (
            <span className="tab-dot" aria-label={`${conflicts} to resolve`} />
          )}
        </button>
      ))}
    </nav>
  );
}
