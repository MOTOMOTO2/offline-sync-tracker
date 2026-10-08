import { useSyncExternalStore } from 'react';

import { engine } from '../engine';
import type { EngineSnapshot } from '../lib/syncEngine';

/** Subscribe to the engine. It hands back a stable snapshot per change. */
export function useEngineSnapshot(): EngineSnapshot {
  return useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    engine.getSnapshot,
    engine.getSnapshot,
  );
}
