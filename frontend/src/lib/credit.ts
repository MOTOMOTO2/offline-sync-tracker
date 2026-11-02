/**
 * Credit scores, kept by hand: no bank or Plaid API hands them out, so they're
 * entered as read off a bank app or a bureau's site. Utilisation is worked out
 * on the server from the connected credit cards.
 */

import { call } from './bank';

export interface CreditScore {
  id: number;
  score: number;
  on: string;
  source: string;
}

export interface Utilization {
  balance_cents: number;
  limit_cents: number;
  ratio: number;
  cards: number;
}

export interface CreditData {
  scores: CreditScore[];
  utilization: Utilization | null;
}

export const fetchCredit = () => call<CreditData>('/api/credit');

export const addCreditScore = (score: number, on: string, source: string) =>
  call<CreditScore>('/api/credit', 'POST', { score, on, source });

export const removeCreditScore = (id: number) => call<{ removed: number }>(`/api/credit/${id}`, 'DELETE');

export const MIN_SCORE = 300;
export const MAX_SCORE = 900;

/** Equifax Canada's bands. */
export function band(score: number): string {
  if (score >= 760) return 'Excellent';
  if (score >= 725) return 'Very good';
  if (score >= 660) return 'Good';
  if (score >= 560) return 'Fair';
  return 'Poor';
}
