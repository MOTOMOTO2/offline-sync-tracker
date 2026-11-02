import { useEffect, useState } from 'react';

import { bankEvents, readCache, writeCache } from '../lib/bank';

/**
 * Something the bank side of the server knows (balances, subscriptions):
 * the last answer straight away, from this device, then a fresh one whenever
 * there's a connection and whenever bank data changes.
 */
export function useBankData<T>(
  kind: 'subscriptions' | 'balances' | 'credit',
  userId: string,
  fetcher: () => Promise<T>,
): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(() => readCache<T>(kind, userId));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetcher()
        .then((value) => {
          if (cancelled) return;
          setData(value);
          writeCache(kind, userId, value);
        })
        .catch(() => {
          /* offline: the cached answer stands */
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    bankEvents.addEventListener('changed', load);
    return () => {
      cancelled = true;
      bankEvents.removeEventListener('changed', load);
    };
    // fetcher is a module-level function; kind and userId pick the data.
  }, [kind, userId]);

  return { data, loading };
}
