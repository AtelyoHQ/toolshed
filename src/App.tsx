import InstallPrompt from './components/InstallPrompt';
import UpdateNotice from './components/UpdateNotice';

export default function App() {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-shell-200 dark:border-shell-700">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <img src="./favicon.svg" alt="" width={24} height={24} className="rounded" />
          <span className="font-semibold tracking-tight">toolshed</span>
          <span className="text-shell-400 text-sm">private file tools</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Nothing here yet</h1>
        <p className="text-shell-400 mt-2 max-w-prose text-sm">
          The build is up. The engines and the interface land in the pull requests that follow.
        </p>
      </main>
      {/*
        Both notices are transient and neither belongs in the page flow, so
        they share one corner and stack rather than overlapping. The column
        itself ignores pointer events: an empty one must not swallow clicks on
        whatever the tools put underneath it.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 p-4 sm:items-end">
        <UpdateNotice />
        <InstallPrompt />
      </div>
    </div>
  );
}
