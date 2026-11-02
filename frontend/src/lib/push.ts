/**
 * Turning notifications on and off for this device.
 *
 * The browser makes a push subscription signed for the server's public key;
 * the server keeps it and sends to it (backend/app/notify.py). An iPhone only
 * offers this to a Home Screen app, so outside one the answer is "add it first".
 */

import { call } from './bank';
import { requestJson } from './transport';

export type PushState =
  | 'unsupported' // this browser can't
  | 'needs-install' // an iPhone or iPad, in Safari rather than from the Home Screen
  | 'not-configured' // the server has no keys
  | 'denied' // blocked in settings
  | 'off'
  | 'on';

function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function keyBytes(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function serverKey(): Promise<string | null> {
  const config = await requestJson<{ configured: boolean; public_key: string }>('/api/notify/config');
  return config.configured ? config.public_key : null;
}

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  try {
    if (!(await serverKey())) return 'not-configured';
  } catch {
    /* offline: say what this device knows */
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function turnOn(): Promise<PushState> {
  const key = await serverKey();
  if (!key) return 'not-configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key) as BufferSource,
    }));
  const json = subscription.toJSON();
  await call('/api/notify/subscribe', 'POST', {
    endpoint: json.endpoint,
    keys: json.keys,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return 'on';
}

export async function turnOff(): Promise<PushState> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await call('/api/notify/unsubscribe', 'POST', { endpoint: subscription.endpoint }).catch(() => undefined);
    await subscription.unsubscribe();
  }
  return 'off';
}

export const sendTest = () => call<{ ok: boolean }>('/api/notify/test', 'POST');
