/** Monthly budgets per category. Kept on the server, which sends the alerts. */

import { call } from './bank';

export interface Budget {
  category: string;
  amount_cents: number;
}

export const fetchBudgets = () => call<{ budgets: Budget[] }>('/api/budgets');

export const saveBudget = (category: string, amountCents: number) =>
  call<Budget>(`/api/budgets/${encodeURIComponent(category)}`, 'PUT', { amount_cents: amountCents });

export const removeBudget = (category: string) =>
  call<{ removed: string }>(`/api/budgets/${encodeURIComponent(category)}`, 'DELETE');
