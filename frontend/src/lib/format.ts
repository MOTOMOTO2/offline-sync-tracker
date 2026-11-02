/** Display helpers. Money is stored in integer cents; never in a float. */

import type { FieldName, Fields } from './types';

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const amount = (abs / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${amount}`;
}

/** Whole dollars, for headline numbers where cents are noise. */
export function formatMoneyWhole(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString('en-US')}`;
}

export function parseMoney(input: string): number | null {
  const trimmed = input.trim().replace(/[$,\s]/g, '');
  if (trimmed === '' || !/^-?\d*\.?\d{0,2}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export function todayISO(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const FIELD_LABELS: Record<FieldName, string> = {
  occurred_on: 'Date',
  amount_cents: 'Amount',
  category: 'Category',
  merchant: 'Merchant',
  note: 'Note',
  bank: 'Bank',
};

export function fieldLabel(name: FieldName): string {
  return FIELD_LABELS[name] ?? name;
}

export function displayValue(name: FieldName, fields: Partial<Fields>): string {
  const value = fields[name];
  if (value === undefined || value === null || value === '') return '--';
  if (name === 'amount_cents') return formatMoney(Number(value));
  if (name === 'occurred_on') return formatDay(String(value));
  return String(value);
}
