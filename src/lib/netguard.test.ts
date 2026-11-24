import { describe, expect, it } from 'vitest';
import { installNetGuard, isSameOrigin } from './netguard';

const ORIGIN = 'https://toolshed.test';

/** A minimal stand-in for `window`, so the guard can be tested in Node. */
function makeScope() {
  const calls: string[] = [];
  const scope = {
    fetch: (input: unknown) => {
      calls.push(`fetch:${String(input)}`);
      return Promise.resolve('ok');
    },
    navigator: {
      sendBeacon: (url: string) => {
        calls.push(`beacon:${url}`);
        return true;
      },
    },
  } as unknown as typeof globalThis;
  return { scope, calls };
}

describe('installNetGuard', () => {
  it('starts at zero', () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    expect(guard.externalCount()).toBe(0);
    expect(guard.sameOriginCount()).toBe(0);
    guard.uninstall();
  });

  it('counts a same-origin fetch without calling it external', async () => {
    const { scope, calls } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    await scope.fetch(`${ORIGIN}/assets/codec.wasm`);
    expect(guard.sameOriginCount()).toBe(1);
    expect(guard.externalCount()).toBe(0);
    expect(calls).toHaveLength(1);
    guard.uninstall();
  });

  it('counts a cross-origin fetch as external', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    await scope.fetch('https://analytics.example.com/collect');
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });

  it('blocks external requests when blocking is on, and lets same-origin through', async () => {
    const { scope, calls } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN, block: true });

    await expect(scope.fetch('https://analytics.example.com/collect')).rejects.toThrow(
      /never sends your files/i,
    );
    await expect(scope.fetch(`${ORIGIN}/assets/codec.wasm`)).resolves.toBe('ok');

    expect(calls).toEqual([`fetch:${ORIGIN}/assets/codec.wasm`]);
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });

  it('treats data: and blob: URLs as inert', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN, block: true });
    await scope.fetch('blob:https://toolshed.test/abc');
    await scope.fetch('data:text/plain,hello');
    expect(guard.externalCount()).toBe(0);
    guard.uninstall();
  });

  it('resolves relative URLs against the origin', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    await scope.fetch('/assets/index.js');
    expect(guard.externalCount()).toBe(0);
    expect(guard.attempts()[0]?.url).toBe(`${ORIGIN}/assets/index.js`);
    guard.uninstall();
  });

  it('refuses a beacon to another origin and reports failure to the caller', () => {
    const { scope, calls } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN, block: true });
    expect(scope.navigator.sendBeacon('https://tracker.example.com/t')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    let notifications = 0;
    const unsubscribe = guard.subscribe(() => {
      notifications += 1;
    });
    await scope.fetch(`${ORIGIN}/a`);
    expect(notifications).toBe(1);
    unsubscribe();
    await scope.fetch(`${ORIGIN}/b`);
    expect(notifications).toBe(1);
    guard.uninstall();
  });

  it('restores the original globals on uninstall', async () => {
    const { scope, calls } = makeScope();
    const original = scope.fetch;
    const guard = installNetGuard({ scope, origin: ORIGIN, block: true });
    expect(scope.fetch).not.toBe(original);
    guard.uninstall();
    expect(scope.fetch).toBe(original);
    await scope.fetch('https://anywhere.example.com');
    expect(calls).toHaveLength(1);
  });
});

describe('scheme normalisation', () => {
  it('treats a websocket to the same host as same-origin', () => {
    // Otherwise the dev server hot-reload socket reads as an external request.
    const scope = { WebSocket: class {} } as unknown as typeof globalThis;
    const guard = installNetGuard({ scope, origin: 'http://localhost:5173' });
    new (scope as unknown as { WebSocket: new (u: string) => unknown }).WebSocket(
      'ws://localhost:5173/?token=abc',
    );
    expect(guard.externalCount()).toBe(0);
    expect(guard.sameOriginCount()).toBe(1);
    guard.uninstall();
  });

  it('still counts a websocket to another host as external', () => {
    const scope = { WebSocket: class {} } as unknown as typeof globalThis;
    const guard = installNetGuard({ scope, origin: 'http://localhost:5173' });
    new (scope as unknown as { WebSocket: new (u: string) => unknown }).WebSocket(
      'wss://tracker.example.com/socket',
    );
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });
});

describe('origin comparison', () => {
  const ORIGIN_UNDER_TEST = 'https://toolshed.app';

  it('rejects hosts that merely start with the origin', () => {
    // A string prefix test says yes to every one of these. The host is
    // evil.example in two of them, which is exactly how someone would walk
    // past a checker like this.
    for (const hostile of [
      'https://toolshed.app.evil.example/collect',
      'https://toolshed.appx.example/collect',
      'https://toolshed.app@evil.example/collect',
      'https://toolshed.app.evil.example',
    ]) {
      expect(isSameOrigin(hostile, ORIGIN_UNDER_TEST), hostile).toBe(false);
    }
  });

  it('accepts the origin itself and paths under it', () => {
    for (const ours of [
      'https://toolshed.app',
      'https://toolshed.app/',
      'https://toolshed.app/assets/codec.wasm',
      'https://toolshed.app/a?b=https://evil.example',
    ]) {
      expect(isSameOrigin(ours, ORIGIN_UNDER_TEST), ours).toBe(true);
    }
  });

  it('separates port and scheme', () => {
    expect(isSameOrigin('https://toolshed.app:8443/x', ORIGIN_UNDER_TEST)).toBe(false);
    expect(isSameOrigin('http://toolshed.app/x', ORIGIN_UNDER_TEST)).toBe(false);
  });

  it('treats anything unparseable as external, rather than guessing', () => {
    expect(isSameOrigin('not a url', ORIGIN_UNDER_TEST)).toBe(false);
    expect(isSameOrigin('', ORIGIN_UNDER_TEST)).toBe(false);
  });

  it('blocks a lookalike host end to end', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN_UNDER_TEST, block: true });
    await expect(scope.fetch('https://toolshed.app.evil.example/collect')).rejects.toThrow(
      /never sends your files/i,
    );
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });
});

describe('attempt log', () => {
  it('counts without growing without bound', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    for (let i = 0; i < 600; i++) await scope.fetch(`${ORIGIN}/a/${i}`);
    expect(guard.sameOriginCount()).toBe(600);
    // The counts are the answer; the log is a debugging tail and is capped.
    expect(guard.attempts().length).toBeLessThanOrEqual(500);
  });
});

describe('an opaque page origin', () => {
  // A file:// document, a sandboxed iframe or a srcdoc reports its origin as
  // the string "null". Nothing can be same-origin with that, so blocking
  // would refuse the app's own .wasm and break every tool.
  it('counts but does not block, rather than becoming a kill switch', async () => {
    const { scope, calls } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null', block: true });

    await expect(scope.fetch('/assets/codec.wasm')).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(guard.attempts()[0]?.blocked).toBe(false);
    guard.uninstall();
  });

  it('still records what was attempted', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null', block: true });
    await scope.fetch('https://tracker.example.com/collect');
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });
});

describe('attempts()', () => {
  it('returns a copy, so a snapshot does not mutate under the caller', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    await scope.fetch(`${ORIGIN}/a`);
    const snapshot = guard.attempts();
    await scope.fetch(`${ORIGIN}/b`);
    expect(snapshot).toHaveLength(1);
    expect(guard.attempts()).toHaveLength(2);
    guard.uninstall();
  });
});

describe('counting on an opaque origin', () => {
  it('does not report the app loading its own files as external', async () => {
    // Relative URLs cannot be resolved against an opaque origin, so they stay
    // relative. Counting them as external parks the headline number above
    // zero while nothing has left the machine, which is how a counter stops
    // being read at all.
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null' });

    await scope.fetch('./assets/entry-index.js');
    await scope.fetch('/wasm/mozjpeg.wasm');

    expect(guard.externalCount()).toBe(0);
    expect(guard.sameOriginCount()).toBe(2);
    guard.uninstall();
  });

  it('still counts a fully qualified other origin as external', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null' });
    await scope.fetch('https://tracker.example.com/collect');
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });
});

describe('a subscriber that throws', () => {
  it('does not stop the other subscribers or break the caller', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: ORIGIN });
    let reached = 0;

    guard.subscribe(() => {
      throw new Error('a broken counter component');
    });
    guard.subscribe(() => {
      reached += 1;
    });

    await expect(scope.fetch(`${ORIGIN}/a`)).resolves.toBe('ok');
    expect(reached).toBe(1);
    guard.uninstall();
  });
});

describe('protocol-relative URLs', () => {
  it('are external even when the page origin is opaque', async () => {
    // In a sandboxed iframe this resolves against the document base and
    // really does leave the machine. Counting it as ours would put a zero on
    // the one number this whole feature exists to produce.
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null' });
    await scope.fetch('//evil.example/steal');
    expect(guard.externalCount()).toBe(1);
    guard.uninstall();
  });

  it('do not stop a relative path counting as ours', async () => {
    const { scope } = makeScope();
    const guard = installNetGuard({ scope, origin: 'null' });
    await scope.fetch('./assets/entry-index.js');
    expect(guard.externalCount()).toBe(0);
    guard.uninstall();
  });
});

describe('backslash URL forms', () => {
  it('are treated as another origin, like their slash equivalents', async () => {
    // The URL parser treats \ as / for special schemes, so /\host and \\host
    // resolve to that host exactly as //host does.
    for (const hostile of ['/\\evil.example/steal', '\\\\evil.example/steal']) {
      const { scope } = makeScope();
      const guard = installNetGuard({ scope, origin: 'null' });
      await scope.fetch(hostile);
      expect(guard.externalCount(), hostile).toBe(1);
      guard.uninstall();
    }
  });
});
