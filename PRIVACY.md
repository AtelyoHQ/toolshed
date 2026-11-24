# Privacy

Toolshed collects nothing. There is no server to collect it with.

The whole application is a folder of static files. Every file you open is read,
processed and written inside your own browser tab, by WebAssembly running on
your machine. Nothing you open is uploaded, and closing the tab discards it.

- No accounts, no sign-in, no cookies.
- No analytics, telemetry, crash reporting or "anonymous usage statistics".
- No fonts, scripts or stylesheets loaded from anyone else's server.
- No file ever sent anywhere, including to us. There is no "us" to send it to.

## How that is enforced, and where the gaps are

Promises in a README are worth very little, so this is held up by several
independent things. They are listed with their real limits, not their best
case.

**1. A Content-Security-Policy, sent as a response header.**
`default-src 'self'` and `connect-src 'self'` mean the browser itself refuses
any connection to another origin. This is the only measure that holds against
code nobody here reviewed — a dependency that is compromised after this was
written, for instance.

`connect-src` is `'self'` and not `'none'` because the WebAssembly codecs fetch
their own `.wasm` files from this same origin. No other origin is reachable.

pdf.js is the one dependency that resolves part of itself at runtime: three
WebAssembly modules, fourteen standard fonts and a hundred and sixty-eight
character maps, each fetched from a base URL it is given and appends a file
name to. Those bases default to nothing, so left alone pdf.js builds paths out
of the literal string "null" and requests those. All of the files are bundled
and pdf.js is handed the directory they are in, which is what keeps
`connect-src 'self'` sufficient here rather than a matter of luck. Colour
management is the one thing pdf.js checks before it fetches: without the wasm
base it switches that off instead of requesting anything, and the CMYK colour
profile is never requested at all.

Those requests happen inside a worker pdf.js starts for itself, which the
counter in the header does not wrap — that counter is the page's own tally.
Your browser's Network tab does show them. What holds the line here is the
response-header policy and an end-to-end test that fails if any request leaves
this origin.

The policy ships twice, and the difference matters:

- As a `<meta>` tag in `index.html`. This covers the page, and it works on
  every host, including ones that cannot send custom headers.
- As a real response header, via `public/_headers` (Netlify, Cloudflare Pages)
  and `vercel.json` (Vercel).

**A `<meta>` tag does not apply to Web Workers.** A worker takes its policy
from the HTTP response that served its own script. Since the file processing
happens in workers, a deployment that cannot send response headers — GitHub
Pages, for example — leaves those workers without browser-enforced egress
control, and falls back on the two measures below. If you are self-hosting and
you can send headers, send them; [DEPLOYING.md](DEPLOYING.md) says which hosts
can.

One thing a CSP cannot do, in any browser shipping today: stop a top-level
navigation or a `window.open` to another address. The directive for that
(`navigate-to`) was dropped from the specification. So code that got into the
page could still smuggle data out inside a URL it navigates to. The test and
the lint rules below do not catch that either. It is a narrow channel and a
noisy one — you would see the page leave — but it is not nothing, and this
document would be dishonest without it.

**2. A test that watches the real thing.**
An end-to-end test loads the built application in a real browser and fails if a
single request goes to another origin. This is what catches a font or a tracker
added to the HTML or the stylesheet, which no JavaScript linter would ever
parse.

**3. Lint rules.**
`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`
and remote dynamic imports are errors outside the one file allowed to wrap
them. This is a first line of defence: it stops an accident, not somebody
determined.

## Checking it yourself

Do not take any of the above on trust:

1. Open your browser's developer tools, go to the Network tab, and process a
   file. Every request is to this origin, and none of them carries your
   file.
2. Load the page, then disconnect from the network entirely and keep working.
3. Read `index.html`, `public/_headers` and `e2e/app.spec.ts`. They are short.

## What is kept on your machine

To work offline, the application stores a copy of its own code in the browser's
cache. Your files are never put there.

Two other things are stored, in local storage, and both are preferences you
set yourself: whether you waved away the offer to install the app, so it is
not offered again, and whether you chose the light or dark theme. Neither is
an identifier and neither describes a file you opened.

Alongside the cache, the service worker keeps its own bookkeeping in IndexedDB
— the address and fetch time of each cached file — because the cache is capped
and something has to know what is oldest. That amounts to a local note of which
of the app's own codecs you have used, which is as far as it goes: no
identifier, nothing about the files you opened, and nothing that is sent
anywhere, since there is nowhere to send it. Clearing site data removes all of
it.
