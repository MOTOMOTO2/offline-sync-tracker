/**
 * Connected banks, through Plaid.
 *
 * The browser's part is small: open Plaid Link (Plaid's own sign-in window for
 * the bank), and hand the token it returns to the server. The server keeps the
 * bank login and turns transactions into entries through the sync protocol, so
 * they reach this device the same way an edit from another phone does - on the
 * next pull. Nothing here touches the outbox.
 *
 * Unlike the ledger, none of this works offline: it's all a conversation with
 * the bank. Subscriptions are cached so the list still shows with no signal.
 */

import { getAccessToken } from './auth';
import { requestJson } from './transport';

export interface BankItem {
  item_id: string;
  institution: string;
  accounts: { name: string; mask: string; subtype: string }[];
  status: 'ok' | 'login_required' | 'revoked' | 'error';
  status_detail: string;
  last_synced_at: string | null;
}

export interface BankStatus {
  configured: boolean;
  environment: 'sandbox' | 'production' | null;
  items: BankItem[];
}

export interface Imported {
  added: number;
  matched: number;
  updated: number;
  removed: number;
}

export interface RecurringStream {
  merchant: string;
  category: string;
  frequency: 'weekly' | 'biweekly' | 'semi_monthly' | 'monthly' | 'quarterly' | 'annually';
  amount_cents: number;
  monthly_cents: number;
  last_date: string;
  next_date: string | null;
  source: 'plaid' | 'history';
}

export interface Subscriptions {
  source: 'plaid' | 'history';
  streams: RecurringStream[];
  monthly_total_cents: number;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await getAccessToken();
  return requestJson<T>(
    `/api/bank/${path}`,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
    // The first sync after connecting can bring in three months at once.
    60_000,
  );
}

export const bankStatus = () => api<BankStatus>('status');

export const refreshBanks = (force = false, fromStart = false) =>
  api<{ imported: Imported; items: BankItem[] }>('refresh', 'POST', { force, from_start: fromStart });

export const disconnectBank = (itemId: string) =>
  api<{ removed: string }>(`items/${encodeURIComponent(itemId)}`, 'DELETE');

export const fetchSubscriptions = () => api<Subscriptions>('subscriptions');

export interface Account {
  item_id: string;
  institution: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  /** A credit card or loan: its balance is what's owed. */
  owed: boolean;
  current_cents: number;
  available_cents: number | null;
  limit_cents: number | null;
  currency: string;
  as_of: string | null;
}

export interface Balances {
  accounts: Account[];
  totals: { currency: string; have_cents: number; owe_cents: number; net_cents: number }[];
}

export const fetchBalances = () => api<Balances>('balances');

/**
 * "The bank data changed": a bank was connected or removed, or a refresh
 * brought something in. Views showing balances or subscriptions refetch.
 */
export const bankEvents = new EventTarget();
export const announceBankChange = () => bankEvents.dispatchEvent(new Event('changed'));

// -- Plaid Link ------------------------------------------------------------------

interface PlaidHandler {
  open(): void;
  destroy(): void;
}

interface PlaidLinkMetadata {
  institution?: { name?: string } | null;
}

interface PlaidLinkError {
  error_message?: string;
  display_message?: string | null;
}

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        receivedRedirectUri?: string;
        onSuccess(publicToken: string, metadata: PlaidLinkMetadata): void;
        onExit(error: PlaidLinkError | null): void;
      }): PlaidHandler;
    };
  }
}

const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
// Banks that sign in on their own site send the browser away and back; the
// link token has to survive the trip.
const PENDING_LINK_KEY = 'tally:plaid-link';

let scriptLoad: Promise<void> | null = null;

function loadLinkScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  scriptLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Plaid requires Link to be loaded from its CDN, not bundled.
    script.src = LINK_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoad = null;
      reject(new Error('Could not load Plaid. Check the connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

interface PendingLink {
  token: string;
  itemId: string | null;
}

function savePending(pending: PendingLink | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_LINK_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch {
    /* private mode: only banks that leave the page are affected */
  }
}

function readPending(): PendingLink | null {
  try {
    const raw = sessionStorage.getItem(PENDING_LINK_KEY);
    return raw ? (JSON.parse(raw) as PendingLink) : null;
  } catch {
    return null;
  }
}

/** What happened when Link closed. */
export type LinkOutcome =
  | { status: 'connected'; item: BankItem; imported: Imported | null }
  | { status: 'reconnected' }
  | { status: 'cancelled' };

function runLink(pending: PendingLink, receivedRedirectUri?: string): Promise<LinkOutcome> {
  return loadLinkScript().then(
    () =>
      new Promise<LinkOutcome>((resolve, reject) => {
        const handler = window.Plaid!.create({
          token: pending.token,
          receivedRedirectUri,
          onSuccess: (publicToken, metadata) => {
            savePending(null);
            handler.destroy();
            if (pending.itemId) {
              // Update mode: the login is fixed; nothing to exchange.
              refreshBanks(true).then(() => resolve({ status: 'reconnected' }), reject);
              return;
            }
            api<{ item: BankItem; imported: Imported | null }>('exchange', 'POST', {
              public_token: publicToken,
              institution: metadata.institution?.name ?? '',
            }).then((result) => resolve({ status: 'connected', ...result }), reject);
          },
          onExit: (error) => {
            savePending(null);
            handler.destroy();
            if (error) reject(new Error(error.display_message || error.error_message || 'The bank sign-in failed.'));
            else resolve({ status: 'cancelled' });
          },
        });
        handler.open();
      }),
  );
}

/** Open Link to connect a bank, or with `itemId`, to sign back in to one. */
export async function openLink(itemId: string | null = null): Promise<LinkOutcome> {
  const { link_token } = await api<{ link_token: string }>(
    'link-token',
    'POST',
    itemId ? { item_id: itemId } : {},
  );
  const pending = { token: link_token, itemId };
  savePending(pending);
  return runLink(pending);
}

/**
 * If this page load is a bank's OAuth sign-in sending the browser back, carry
 * on with Link where it left off. Null when it isn't.
 */
export function resumeLinkAfterRedirect(): Promise<LinkOutcome> | null {
  if (!new URLSearchParams(window.location.search).has('oauth_state_id')) return null;
  const pending = readPending();
  const received = window.location.href;
  // Tidy the address bar either way; the state id is single-use.
  window.history.replaceState(null, '', window.location.pathname);
  return pending ? runLink(pending, received) : null;
}

// -- last answers, for showing with no signal --------------------------------------

type CacheKind = 'subscriptions' | 'balances';

const cacheKey = (kind: CacheKind, userId: string) => `tally:${kind}:${userId}`;

export function readCache<T>(kind: CacheKind, userId: string): T | null {
  try {
    const raw = localStorage.getItem(cacheKey(kind, userId));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCache(kind: CacheKind, userId: string, value: unknown): void {
  try {
    localStorage.setItem(cacheKey(kind, userId), JSON.stringify(value));
  } catch {
    /* storage full or blocked: the view just won't show offline */
  }
}

/** Signing out: nothing of this account's stays on the device. */
export function forgetBankCache(userId: string): void {
  for (const kind of ['subscriptions', 'balances'] as const) {
    try {
      localStorage.removeItem(cacheKey(kind, userId));
    } catch {
      /* nothing to forget */
    }
  }
}
