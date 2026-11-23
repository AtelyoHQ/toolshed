/**
 * Counts, and in production blocks, any attempt to talk to another origin.
 *
 * The promise Toolshed makes is that your files do not leave the machine, and a
 * promise nobody can check is worth very little. This guard wraps the request
 * APIs a page is most likely to reach for and keeps a tally the header renders.
 *
 * It is not a complete list and does not pretend to be: an <img src>, an
 * injected <script>, an RTCPeerConnection or a top-level navigation all bypass
 * it. Those are the Content-Security-Policy's job. This layer exists because a
 * CSP is invisible — it gives a number a person can watch.
 *
 * It wraps whatever scope it is given, so a worker entry point installs it for
 * itself; a worker does not inherit the window's patched globals.
 *
 * Same-origin requests are counted separately and allowed: loading the app's
 * own code and its `.wasm` codecs is a same-origin fetch, and `connect-src`
 * in the Content-Security-Policy is set to `'self'` for the same reason.
 * The number that must stay at zero is the *external* one.
 */

const MAX_LOG = 500;

/**
 * scheme://... or //host/... — anything else is a path that was never
 * resolved. The protocol-relative form matters: it names another host and
 * really does leave the machine, so counting it as ours would put a zero on
 * the one number this whole feature exists to produce. The backslash variants
 * are included because the URL parser treats \ as / for special schemes, so
 * /\host and \\host resolve to that host just as //host does.
 */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|[/\\][/\\])/i;

export type NetKind = 'fetch' | 'xhr' | 'websocket' | 'eventsource' | 'beacon';

export interface NetAttempt {
  kind: NetKind;
  url: string;
  external: boolean;
  blocked: boolean;
  at: number;
}

export interface NetGuard {
  /** Attempts to reach another origin. This is the number that must be zero. */
  externalCount(): number;
  sameOriginCount(): number;
  attempts(): readonly NetAttempt[];
  subscribe(listener: (guard: NetGuard) => void): () => void;
  /** Restores the original globals. Used by tests. */
  uninstall(): void;
}

export class ExternalRequestBlocked extends Error {
  constructor(public readonly url: string) {
    super(
      `Toolshed blocked a request to ${url}. This application never sends your ` +
        `files or any other data off your machine; please report this as a bug.`,
    );
    this.name = 'ExternalRequestBlocked';
  }
}

/**
 * `ws://host` and `http://host` are the same origin for our purposes, but
 * their origin strings differ. Without this the dev server's hot-reload
 * socket reads as an external request and the counter is noise.
 */
function normaliseScheme(url: string): string {
  if (url.startsWith('wss:')) return `https:${url.slice(4)}`;
  if (url.startsWith('ws:')) return `http:${url.slice(3)}`;
  return url;
}

/**
 * Whether a URL points at this exact origin.
 *
 * Parsed, never compared as a string. A prefix test says yes to
 * `https://toolshed.app.evil.example` and to `https://toolshed.app@evil.example`,
 * where the real host is `evil.example` and the origin only appears at the
 * front — which is precisely how someone would get past a checker like this.
 *
 * Anything unparseable counts as external: the job of this function is to be
 * sure a request is safe, and "I could not tell" is not sure.
 */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(normaliseScheme(url)).origin === new URL(normaliseScheme(origin)).origin;
  } catch {
    return false;
  }
}

function resolveUrl(input: unknown, base: string): string {
  try {
    if (typeof input === 'string') return new URL(input, base).href;
    if (input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return new URL(input.url, base).href;
    }
  } catch {
    /* fall through to the raw value below */
  }
  return String(input);
}

export interface NetGuardOptions {
  /**
   * Block external attempts rather than only recording them. Off in dev, where
   * the Vite HMR socket is an external-looking request to the dev server.
   */
  block?: boolean;
  /** Overridable for tests. */
  scope?: typeof globalThis;
  origin?: string;
}

export function installNetGuard(options: NetGuardOptions = {}): NetGuard {
  const scope = options.scope ?? globalThis;
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : 'null');
  const block = options.block ?? false;

  /**
   * A document with an opaque origin — a file:// page, a sandboxed iframe, a
   * srcdoc — reports `location.origin` as the string "null". Nothing can be
   * same-origin with it, so blocking would refuse the app's own .wasm and
   * break every tool. Counting still works and the CSP is unaffected, so the
   * guard degrades to observing rather than becoming a kill switch.
   */
  const originKnown = (() => {
    try {
      new URL(origin);
      return true;
    } catch {
      return false;
    }
  })();
  const blocking = block && originKnown;

  const log: NetAttempt[] = [];
  let externalAttempts = 0;
  let sameOriginAttempts = 0;
  const listeners = new Set<(guard: NetGuard) => void>();
  const restores: Array<() => void> = [];

  const guard: NetGuard = {
    externalCount: () => externalAttempts,
    sameOriginCount: () => sameOriginAttempts,
    // A copy: the log is mutated in place, so handing out the live array
    // would give a UI snapshot that never changes identity and never renders.
    attempts: () => [...log],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    uninstall() {
      for (const restore of restores.reverse()) restore();
      restores.length = 0;
      listeners.clear();
    },
  };

  /** @returns true when the caller should be stopped. */
  function record(kind: NetKind, rawUrl: unknown): NetAttempt {
    const url = resolveUrl(rawUrl, origin);
    // Data and blob URLs never touch the network.
    const inert = url.startsWith('data:') || url.startsWith('blob:');
    // With an opaque origin a relative URL cannot be resolved, so it stays
    // relative. Counting the app's own './assets/index.js' as external would
    // park the headline number above zero while nothing had left the machine,
    // which is exactly how a counter stops being read.
    const unresolved = !originKnown && !ABSOLUTE_URL.test(url);
    const external = !inert && !unresolved && !isSameOrigin(url, origin);
    const attempt: NetAttempt = {
      kind,
      url,
      external,
      blocked: external && blocking,
      at: Date.now(),
    };

    if (external) externalAttempts += 1;
    else sameOriginAttempts += 1;

    // The counts above are the answer; this is only a tail for debugging, and
    // it is capped so a long session cannot grow it without bound.
    log.push(attempt);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);

    for (const listener of listeners) {
      // A listener that throws must not take out the others, and must not
      // make the caller's own fetch fail.
      try {
        listener(guard);
      } catch {
        /* a broken subscriber is not the caller's problem */
      }
    }
    return attempt;
  }

  const target = scope as unknown as Record<string, unknown>;

  if (typeof target.fetch === 'function') {
    const original = target.fetch as typeof fetch;
    target.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
      const attempt = record('fetch', input);
      if (attempt.blocked) return Promise.reject(new ExternalRequestBlocked(attempt.url));
      return original.call(scope, input, init);
    } as typeof fetch;
    restores.push(() => {
      target.fetch = original;
    });
  }

  const XHR = target.XMLHttpRequest as typeof XMLHttpRequest | undefined;
  if (XHR) {
    const originalOpen = XHR.prototype.open;
    XHR.prototype.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
      const attempt = record('xhr', args[1]);
      if (attempt.blocked) throw new ExternalRequestBlocked(attempt.url);
      return (originalOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof XHR.prototype.open;
    restores.push(() => {
      XHR.prototype.open = originalOpen;
    });
  }

  const WS = target.WebSocket as typeof WebSocket | undefined;
  if (WS) {
    const PatchedWebSocket = new Proxy(WS, {
      construct(wsTarget, args: [string | URL, (string | string[])?], newTarget) {
        const attempt = record('websocket', args[0]);
        if (attempt.blocked) throw new ExternalRequestBlocked(attempt.url);
        // newTarget is forwarded so `class X extends WebSocket {}` still gets
        // an X, not a bare WebSocket.
        return Reflect.construct(wsTarget, args, newTarget);
      },
    });
    target.WebSocket = PatchedWebSocket;
    restores.push(() => {
      target.WebSocket = WS;
    });
  }

  const ES = target.EventSource as typeof EventSource | undefined;
  if (ES) {
    const PatchedEventSource = new Proxy(ES, {
      construct(esTarget, args: [string | URL, EventSourceInit?], newTarget) {
        const attempt = record('eventsource', args[0]);
        if (attempt.blocked) throw new ExternalRequestBlocked(attempt.url);
        return Reflect.construct(esTarget, args, newTarget);
      },
    });
    target.EventSource = PatchedEventSource;
    restores.push(() => {
      target.EventSource = ES;
    });
  }

  const navigatorRef = target.navigator as Navigator | undefined;
  if (navigatorRef && typeof navigatorRef.sendBeacon === 'function') {
    const originalBeacon = navigatorRef.sendBeacon.bind(navigatorRef);
    navigatorRef.sendBeacon = function patchedBeacon(url: string | URL, data?: BodyInit | null) {
      const attempt = record('beacon', url);
      if (attempt.blocked) return false;
      return originalBeacon(url, data);
    };
    const hadOwn = Object.prototype.hasOwnProperty.call(navigatorRef, 'sendBeacon');
    restores.push(() => {
      if (hadOwn) navigatorRef.sendBeacon = originalBeacon;
      // Otherwise it lived on the prototype; deleting restores the native one
      // rather than leaving a bound copy shadowing it.
      else delete (navigatorRef as Partial<Navigator>).sendBeacon;
    });
  }

  return guard;
}

/**
 * The guard for this page, installed once.
 *
 * It goes in as early as a module can, which is early but not first: ES module
 * imports are hoisted, so every module body in the entry bundle has already
 * evaluated, and the service-worker registration script in <head> runs before
 * the module entry at all. Nothing in either place is cross-origin today, and
 * the Content-Security-Policy covers what this cannot. This is the layer that
 * produces a number someone can watch, not the layer that holds the line.
 *
 * Blocking is on in production only: the dev server's own tooling is allowed
 * to talk to the dev server, and failing that would make `npm run dev`
 * useless without making anything safer.
 */
let singleton: NetGuard | null = null;

export function netGuard(): NetGuard {
  if (!singleton) {
    singleton = installNetGuard({ block: import.meta.env.PROD });
  }
  return singleton;
}
