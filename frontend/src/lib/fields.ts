/**
 * Field defaults and client-side validation.
 *
 * These deliberately mirror `backend/app/schemas.py`. The client has to be able
 * to reject bad input while offline - waiting for a server to say "that is not
 * a number" is exactly the round trip this app is built to avoid.
 */

import type { FieldName, Fields } from './types';

export const DEFAULT_FIELDS: Fields = {
  occurred_on: '1970-01-01',
  amount_cents: 0,
  category: 'other',
  merchant: '',
  note: '',
  bank: '',
};

export const CATEGORIES = [
  'groceries',
  'eating out',
  'shopping',
  'transport',
  'travel',
  'bills',
  'health',
  'personal care',
  'fun',
  'home',
  'services',
  'fees',
  'other',
] as const;

export const MAX_LENGTHS: Partial<Record<FieldName, number>> = {
  category: 40,
  merchant: 80,
  note: 280,
  bank: 60,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateFields(patch: Partial<Fields>): string | null {
  for (const [name, value] of Object.entries(patch) as [FieldName, unknown][]) {
    if (name === 'amount_cents') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return 'Amount must be a number.';
      }
      if (Math.abs(value) > 100_000_000) return 'Amount is out of range.';
      continue;
    }
    if (name === 'occurred_on') {
      if (typeof value !== 'string' || !ISO_DATE.test(value)) {
        return 'Date must look like YYYY-MM-DD.';
      }
      continue;
    }
    if (typeof value !== 'string') return `${name} must be text.`;
    const limit = MAX_LENGTHS[name];
    if (limit && value.trim().length > limit) {
      return `${name} is longer than ${limit} characters.`;
    }
  }
  return null;
}

/** Strip fields that are not actually changing, so patches stay minimal. */
export function diffFields(before: Fields, after: Partial<Fields>): Partial<Fields> {
  const patch: Partial<Fields> = {};
  for (const [name, value] of Object.entries(after) as [FieldName, never][]) {
    if (before[name] !== value) patch[name] = value;
  }
  return patch;
}
