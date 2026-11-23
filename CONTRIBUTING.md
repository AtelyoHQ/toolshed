# Contributing to Toolshed

Thanks for taking a look.

## Ground rules

1. **Nothing leaves the browser.** Any change that introduces a network request
   at runtime — analytics, a CDN font, an error reporter, a "just this one API"
   — will be rejected. This is the entire point of the project.
2. **No caps, no accounts, no upsell.** There is no paid tier to protect.
3. **Keep the engines headless.** `src/lib/image` and `src/lib/pdf` must not
   import React or touch `document`. They take bytes and return bytes.

## Getting set up

```sh
npm install
npm run dev
```

## Before you open a pull request

```sh
npm run typecheck && npm run lint && npm run test && npm run format:check
```

`npm run test:e2e` builds the app and drives it in a real browser; run it if you
touched the UI or the worker plumbing.

## Pull requests

- One topic per pull request. If it is a large feature, split it into parts that
  each make sense on their own.
- Say what changed, why, and how you checked it. A reviewer should not have to
  guess at the verification.
- New engine behaviour needs a unit test. New UI behaviour that can break
  silently needs an e2e test.

## Adding a tool

Tools are declared in `src/lib/tools.ts` and dispatched to a worker. A new tool
needs: an entry in the registry, an implementation in the relevant engine, a
settings panel if it takes options, and a unit test for the engine function.

## Reporting a bug

Include the browser and version, the kind of file (never attach a private one —
reproduce with a file you are happy to share), and what you expected versus what
happened. If the file itself is the problem and you cannot share it, a
description of how it was produced is usually enough to reconstruct one.
