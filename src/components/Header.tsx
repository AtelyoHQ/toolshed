import { useEffect, useState } from 'react';
import { netGuard } from '../lib/netguard';

/**
 * The request counter is the whole point of this header.
 *
 * A Content-Security-Policy enforces the no-network rule but is invisible,
 * so there is nothing for a person to check. This is the visible half: it
 * should read zero, forever, and anyone can watch it while they work.
 */
function useExternalRequestCount(): number {
  const [count, setCount] = useState(() => netGuard().externalCount());

  useEffect(() => netGuard().subscribe((guard) => setCount(guard.externalCount())), []);

  return count;
}

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('toolshed:theme');
    if (stored) return stored === 'dark';
    // Dark unless the machine asks for light. The tool is usually open beside
    // a file manager or a form, not read like a page.
    return !window.matchMedia('(prefers-color-scheme: light)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('toolshed:theme', dark ? 'dark' : 'light');
  }, [dark]);

  return [dark, () => setDark((value) => !value)];
}

export function Header() {
  const external = useExternalRequestCount();
  const [dark, toggleTheme] = useTheme();

  return (
    <header className="border-shell-200 dark:border-shell-700 border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
        <img src="./favicon.svg" alt="" width={22} height={22} className="rounded-sm" />
        <span className="font-semibold tracking-tight">toolshed</span>
        <span className="text-shell-400 hidden text-sm sm:inline">
          your files never leave this tab
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span
            className={`rounded px-2 py-1 font-mono text-xs ${
              external === 0
                ? 'bg-shell-100 text-shell-600 dark:bg-shell-800 dark:text-shell-200'
                : 'bg-bad-500/15 text-bad-500'
            }`}
            title={
              external === 0
                ? 'No request has been made to any other origin since this page loaded.'
                : 'Something tried to reach another origin. This should never happen; please report it.'
            }
          >
            <span aria-hidden="true">↑</span> {external} uploads
          </span>

          <button
            type="button"
            onClick={toggleTheme}
            className="border-shell-200 hover:bg-shell-100 dark:border-shell-700 dark:hover:bg-shell-800 rounded border px-2 py-1 text-xs"
            aria-pressed={dark}
          >
            {dark ? 'Light' : 'Dark'}
          </button>

          <a
            className="border-shell-200 hover:bg-shell-100 dark:border-shell-700 dark:hover:bg-shell-800 rounded border px-2 py-1 text-xs"
            href="https://github.com/AtelyoHQ/toolshed"
            rel="noreferrer noopener"
            target="_blank"
          >
            Source
          </a>
        </div>
      </div>
    </header>
  );
}
