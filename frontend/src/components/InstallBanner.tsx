import { useEffect, useState } from 'react';

import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useServiceWorkerUpdate } from '../hooks/useServiceWorkerUpdate';

const DISMISSED_KEY = 'tally:install-dismissed';

/** Offer to install, once, without nagging. */
export function InstallBanner() {
  const { availability, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === '1',
  );
  const [showIosSteps, setShowIosSteps] = useState(false);

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  if (dismissed || availability === 'installed' || availability === 'unavailable') {
    return null;
  }

  return (
    <aside className="install-banner">
      <div className="install-text">
        <strong>Install Tally</strong>
        <small>Opens from your home screen and works with no signal.</small>
        {showIosSteps && (
          <ol className="ios-steps">
            <li>
              Tap the Share button <span aria-hidden="true">&#x2191;</span> in Safari
            </li>
            <li>Choose &ldquo;Add to Home Screen&rdquo;</li>
            <li>Tap Add</li>
          </ol>
        )}
      </div>
      <div className="install-actions">
        {availability === 'prompt' ? (
          <button
            type="button"
            className="primary"
            onClick={async () => {
              const outcome = await promptInstall();
              if (outcome === 'dismissed') dismiss();
            }}
          >
            Install
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => setShowIosSteps((open) => !open)}
          >
            How?
          </button>
        )}
        <button type="button" className="ghost" onClick={dismiss} aria-label="Dismiss">
          Not now
        </button>
      </div>
    </aside>
  );
}

/** Tells the user a new version is waiting, rather than swapping it underneath them. */
export function UpdateToast() {
  const { ready, apply } = useServiceWorkerUpdate();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (ready) setHidden(false);
  }, [ready]);

  if (!ready || hidden) return null;

  return (
    <div className="update-toast" role="status">
      <span>A new version of Tally is ready.</span>
      <button type="button" className="primary" onClick={apply}>
        Reload
      </button>
      <button type="button" className="ghost" onClick={() => setHidden(true)}>
        Later
      </button>
    </div>
  );
}
