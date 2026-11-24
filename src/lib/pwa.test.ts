import { describe, expect, it, vi } from 'vitest';
import {
  installOfferDismissed,
  onNewVersionActive,
  rememberInstallOfferDismissed,
  type ControllerSource,
} from './pwa';

/** A `navigator.serviceWorker` that can be made to change its controller. */
function container(initial: object | null) {
  const listeners = new Set<() => void>();
  const source = {
    controller: initial,
    addEventListener: (_type: 'controllerchange', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'controllerchange', listener: () => void) => {
      listeners.delete(listener);
    },
  };
  return {
    source: source as ControllerSource,
    change(controller: object | null) {
      source.controller = controller;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

const worker = () => ({ scriptURL: 'sw.js' });

describe('onNewVersionActive', () => {
  it('says nothing when the first worker claims a page that had none', () => {
    const notify = vi.fn();
    const sw = container(null);
    onNewVersionActive(notify, sw.source);

    sw.change(worker());

    // The service worker installing for the first time is not a new version
    // of anything, and announcing one would be a lie on every first visit.
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces a worker that replaces the one already in charge', () => {
    const notify = vi.fn();
    const sw = container(worker());
    onNewVersionActive(notify, sw.source);

    sw.change(worker());

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('announces the second claim after a first install', () => {
    const notify = vi.fn();
    const sw = container(null);
    onNewVersionActive(notify, sw.source);

    sw.change(worker());
    sw.change(worker());

    // Having been claimed once, the page is controlled: the next change is a
    // replacement like any other. Without this the very first update after an
    // install would go unmentioned.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('treats losing the controller as an unregistration, not a new version', () => {
    const notify = vi.fn();
    const sw = container(worker());
    onNewVersionActive(notify, sw.source);

    sw.change(null);

    expect(notify).not.toHaveBeenCalled();
  });

  it('stops listening when unsubscribed', () => {
    const notify = vi.fn();
    const sw = container(worker());
    const stop = onNewVersionActive(notify, sw.source);

    stop();
    sw.change(worker());

    expect(sw.listenerCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does nothing where service workers are unavailable', () => {
    const notify = vi.fn();
    // An unsupported browser, or a page served over plain http. The caller
    // still gets an unsubscribe it can call.
    expect(() => onNewVersionActive(notify, null)()).not.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('the install dismissal', () => {
  function storage(): Storage {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    } as unknown as Storage;
  }

  it('is not set to begin with, and survives being written', () => {
    const store = storage();
    expect(installOfferDismissed(store)).toBe(false);
    rememberInstallOfferDismissed(store);
    expect(installOfferDismissed(store)).toBe(true);
  });

  it('reads as not dismissed where there is no storage at all', () => {
    expect(installOfferDismissed(null)).toBe(false);
    expect(() => rememberInstallOfferDismissed(null)).not.toThrow();
  });

  it('survives a storage that throws on every access', () => {
    // Safari in private mode, and "block all cookies" in several browsers.
    // The offer reappearing is acceptable; a blank page is not.
    const hostile = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage;

    expect(installOfferDismissed(hostile)).toBe(false);
    expect(() => rememberInstallOfferDismissed(hostile)).not.toThrow();
  });
});
