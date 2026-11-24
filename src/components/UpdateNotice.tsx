import { useEffect, useState } from 'react';
import { onNewVersionActive } from '../lib/pwa';

/**
 * Says, once, that a newer version has taken over — and leaves the reload to
 * the person reading it.
 *
 * The service worker updates itself: a new release installs, skips waiting and
 * claims the open tab, which carries on running the code it was loaded with.
 * Without this there is nothing anywhere to say that happened, and the only
 * way to reach the new version is to guess that a reload might help.
 *
 * Reloading automatically would be worse than saying nothing. A reload throws
 * away every queued file and any job in flight, which for this application can
 * be twenty minutes of encoding, so the notice is a line of text and a button
 * rather than a dialog.
 *
 * What it cannot promise is that ignoring it is free. Chunk names are
 * content-hashed and are runtime-cached rather than precached, so a tool this
 * tab has not opened yet will ask for a filename the host stopped serving at
 * the deploy, and only a reload fixes that. Precaching the chunks is the only
 * thing that would, and that trade — a multi-megabyte first visit — is
 * refused on purpose in vite.config.ts. Hence the wording: that a new version
 * is ready, and nothing about it being safe to ignore indefinitely.
 */
export default function UpdateNotice() {
  const [updated, setUpdated] = useState(false);

  useEffect(() => onNewVersionActive(() => setUpdated(true)), []);

  // The live region is mounted from the start and only its contents change.
  // A region inserted into the page already holding its text is frequently
  // not announced at all, which would make the role decorative.
  return (
    <div role="status" aria-live="polite" className="w-full max-w-sm">
      {updated && (
        <div className="pointer-events-auto w-full max-w-sm rounded-lg border border-shell-200 bg-white p-3 text-sm shadow-lg dark:border-shell-700 dark:bg-shell-850">
          <p className="text-shell-600 dark:text-shell-200">A new version of Toolshed is ready.</p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="rounded bg-accent-600 px-3 py-1.5 font-medium text-shell-850 hover:bg-accent-500"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              className="rounded px-2 py-1.5 text-shell-600 hover:text-shell-800 dark:text-shell-400 dark:hover:text-shell-100"
              onClick={() => setUpdated(false)}
            >
              Later
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
