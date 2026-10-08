import { useCallback, useEffect, useState } from 'react';

/**
 * Install prompt plumbing.
 *
 * Chromium fires `beforeinstallprompt`, which must be captured and stashed -
 * it can only be used in response to a user gesture, and only once. Safari on
 * iOS fires nothing at all, so the only honest thing to do there is show the
 * Share -> Add to Home Screen instructions.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallAvailability = 'prompt' | 'ios-manual' | 'installed' | 'unavailable';

export interface InstallPrompt {
  availability: InstallAvailability;
  isStandalone: boolean;
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if (window.matchMedia?.('(display-mode: minimal-ui)').matches) return true;
  // Safari's non-standard flag, still the only signal on iOS.
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iosDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS reports as a Mac, so check for touch as well.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const webkitNotChrome = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
  return (iosDevice || iPadOS) && webkitNotChrome;
}

export function useInstallPrompt(): InstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [standalone, setStandalone] = useState(detectStandalone);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Suppress the mini-infobar so the app can offer install at a sensible
      // moment instead of the browser choosing one.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    const media = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayModeChange = () => setStandalone(detectStandalone());
    media?.addEventListener('change', onDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      media?.removeEventListener('change', onDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return 'unavailable' as const;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // The event is single-use; drop it either way.
    setDeferred(null);
    return outcome;
  }, [deferred]);

  let availability: InstallAvailability = 'unavailable';
  if (standalone || installed) availability = 'installed';
  else if (deferred) availability = 'prompt';
  else if (isIosSafari()) availability = 'ios-manual';

  return { availability, isStandalone: standalone || installed, promptInstall };
}
