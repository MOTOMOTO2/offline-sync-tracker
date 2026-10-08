/**
 * HTTP access to the sync API.
 *
 * Deliberately thin, and deliberately distinguishes "the network is not there"
 * from "the server said no" - the sync engine treats those very differently.
 * An offline push is retried forever; a rejected push is not.
 */

import type { PullResponse, PushResponse, WireOp } from './types';

/** The request never reached a server: radio off, tunnel, captive portal, DNS. */
export class OfflineError extends Error {
  constructor(message = 'no connection') {
    super(message);
    this.name = 'OfflineError';
  }
}

/** A server answered, and the answer was an error. */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

export interface Transport {
  push(deviceId: string, ops: WireOp[]): Promise<PushResponse>;
  pull(since: number, limit?: number): Promise<PullResponse>;
  health(): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 12_000;

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (cause) {
    // fetch only rejects for transport-level failures and aborts, both of
    // which mean "try again later", not "this write was bad".
    throw new OfflineError(cause instanceof Error ? cause.message : 'network failure');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 5xx is the server having a bad day; worth retrying like an outage.
    if (response.status >= 500) {
      throw new OfflineError(`server unavailable (${response.status})`);
    }
    let detail = `request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* body was not JSON; the status line will do */
    }
    throw new ServerError(detail, response.status);
  }

  return (await response.json()) as T;
}

export function createHttpTransport(baseUrl = ''): Transport {
  return {
    async push(deviceId, ops) {
      return requestJson<PushResponse>(`${baseUrl}/api/sync/push`, {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, ops }),
      });
    },

    async pull(since, limit = 200) {
      return requestJson<PullResponse>(
        `${baseUrl}/api/sync/pull?since=${since}&limit=${limit}`,
        { method: 'GET' },
      );
    },

    async health() {
      try {
        await requestJson(`${baseUrl}/api/health`, { method: 'GET' }, 5_000);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Wraps a transport with a switch that pretends the network is gone.
 *
 * This exists so the offline behaviour can be demonstrated from inside the app
 * itself, without asking anyone to find the throttling dropdown in devtools or
 * walk into a lift. It fails the same way a real outage does: an OfflineError
 * before anything reaches the server.
 */
export interface ToggleableTransport extends Transport {
  readonly simulatedOffline: boolean;
  setSimulatedOffline(value: boolean): void;
}

export function createToggleableTransport(inner: Transport): ToggleableTransport {
  let offline = false;

  const guard = () => {
    if (offline) throw new OfflineError('simulated offline');
  };

  return {
    get simulatedOffline() {
      return offline;
    },
    setSimulatedOffline(value: boolean) {
      offline = value;
    },
    async push(deviceId, ops) {
      guard();
      return inner.push(deviceId, ops);
    },
    async pull(since, limit) {
      guard();
      return inner.pull(since, limit);
    },
    async health() {
      if (offline) return false;
      return inner.health();
    },
  };
}
