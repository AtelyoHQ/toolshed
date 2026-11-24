import { useEffect, useState } from 'react';
import { installOfferDismissed, rememberInstallOfferDismissed } from '../lib/pwa';

/**
 * `beforeinstallprompt` is not in lib.dom, and only the one method is used.
 */
interface InstallEvent extends Event {
  prompt(): Promise<unknown>;
}

/**
 * Offers to install Toolshed, quietly, and never again once waved away.
 *
 * Installing is what makes the app available with no network at all, so it is
 * worth a sentence. It is not worth a nag: nothing here schedules the offer or
 * counts visits, because the browser already did that work. Chrome fires
 * `beforeinstallprompt` only once it has decided the app is installable and
 * the person has engaged with it, and fires nothing at all if it is installed
 * already — so a first glance at the page shows no bar, and an installed copy
 * never shows one.
 */
export default function InstallPrompt() {
  const [offer, setOffer] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Suppresses Chrome's own install bar, which sits over the page and
      // cannot be refused for good, and leaves the timing to the code below.
      event.preventDefault();
      // Read on every event rather than once on mount. Checked only at mount,
      // a second event in the same page lifetime brings the bar back after
      // someone has already said no, and the reader cannot tell the
      // difference between that and it never having worked.
      if (installOfferDismissed()) return;
      setOffer(event as InstallEvent);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  if (!offer) return null;

  return (
    <aside
      aria-label="Install Toolshed"
      className="pointer-events-auto w-full max-w-sm rounded-lg border border-shell-200 bg-white p-3 text-sm shadow-lg dark:border-shell-700 dark:bg-shell-850"
    >
      <p className="text-shell-600 dark:text-shell-200">
        Install Toolshed to open it from your dock and use it with no network at all.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded bg-accent-600 px-3 py-1.5 font-medium text-shell-850 hover:bg-accent-500"
          onClick={() => {
            // The saved event can be prompted once, so the bar goes either
            // way: from here the browser's own dialog owns the decision, and
            // if it is refused the browser will offer again when it sees fit.
            // A rejection here is the browser declining to show its dialog,
            // which is its business and not worth an unhandled rejection in
            // somebody's console.
            offer.prompt().catch(() => {});
            setOffer(null);
          }}
        >
          Install
        </button>
        <button
          type="button"
          className="rounded px-2 py-1.5 text-shell-600 hover:text-shell-800 dark:text-shell-400 dark:hover:text-shell-100"
          onClick={() => {
            rememberInstallOfferDismissed();
            setOffer(null);
          }}
        >
          Not now
        </button>
      </div>
    </aside>
  );
}
