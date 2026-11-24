/**
 * The two things the shell has to notice about being an installable, cached
 * application: that the browser is willing to install it, and that a newer
 * version has quietly taken over the page.
 *
 * Neither reaction lives in its component, because both turn on a distinction
 * that is invisible once rendered and easy to get backwards.
 */

const INSTALL_DISMISSED = 'toolshed:install-dismissed';

/**
 * Reading `localStorage` can *throw* rather than return null: Safari's private
 * mode and a blanket "block all cookies" setting both deny access to it
 * outright. Forgetting that someone waved the install offer away is a small
 * annoyance; an exception during the first render takes the whole application
 * down, so every access is guarded and a failure reads as "not dismissed".
 */
function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function installOfferDismissed(storage: Storage | null = localStore()): boolean {
  try {
    return storage?.getItem(INSTALL_DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function rememberInstallOfferDismissed(storage: Storage | null = localStore()): void {
  try {
    storage?.setItem(INSTALL_DISMISSED, '1');
  } catch {
    /* A forgotten dismissal beats an exception on a button press. */
  }
}

/**
 * The part of `navigator.serviceWorker` this needs, so it can be driven by a
 * plain object in a test.
 */
export interface ControllerSource {
  readonly controller: object | null;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

function pageController(): ControllerSource | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker;
}

/**
 * Calls `notify` when a *new* service worker has taken control of this page.
 *
 * `controllerchange` fires for two unrelated events and telling them apart is
 * the entire job here. On a first visit the worker claims a page that had no
 * controller at all: nothing changed underneath the person, and announcing a
 * new version seconds after they arrived is nonsense. On a later visit a
 * freshly installed worker replaces the one already in charge, which is worth
 * a word. The only signal that separates the two is whether a controller
 * existed when we started watching.
 *
 * A change that leaves the page with no controller is not a new version
 * either: that is an unregistration, from devtools or from clearing site
 * data.
 */
export function onNewVersionActive(
  notify: () => void,
  source: ControllerSource | null = pageController(),
): () => void {
  if (!source) return () => {};

  let controlled = source.controller !== null;
  const onChange = () => {
    const nowControlled = source.controller !== null;
    if (controlled && nowControlled) notify();
    controlled = nowControlled;
  };

  source.addEventListener('controllerchange', onChange);
  return () => source.removeEventListener('controllerchange', onChange);
}
