import { useCallback, useEffect, useState } from 'react';

import { serviceWorker } from '../engine';

/** True once a newer service worker is installed and waiting to take over. */
export function useServiceWorkerUpdate(): { ready: boolean; apply: () => void } {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    serviceWorker.onUpdateReady(() => setReady(true));
  }, []);

  const apply = useCallback(() => {
    void serviceWorker.applyUpdate();
  }, []);

  return { ready, apply };
}
