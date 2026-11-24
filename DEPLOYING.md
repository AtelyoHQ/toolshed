# Deploying Toolshed

Toolshed is a folder of static files. `npm run build` writes it to `dist/`, and
any web server that can hand those files to a browser can host it. There is no
backend, no database, no build step on the server and nothing to configure at
runtime.

```sh
npm install
npm run build        # writes ./dist
```

Copy `dist/` wherever you serve static files from. It works at a domain root
and from a subdirectory — asset URLs are relative, and the app's own routes
will live in the URL hash rather than the path, so
`https://example.com/tools/toolshed/` is as valid as
`https://toolshed.example.com/`. `npm run check:subpath` proves it by serving
`dist/` from a nested directory and fetching everything, and it runs in CI.

Two things the browser insists on, whatever the host:

- **HTTPS, or localhost.** Service workers and installation are both refused
  over plain http, so without a certificate there is no offline mode and no
  install.
- **A real server.** Opening `dist/index.html` from the filesystem does not
  work: a module script and a service worker both need an origin.

## Response headers, and which hosts can send them

The Content-Security-Policy is the part of the privacy claim that the browser
enforces rather than the one this repository promises. It ships in two forms,
and the difference is not cosmetic.

The `<meta http-equiv="Content-Security-Policy">` tag in `index.html` travels
with the file and applies on any host at all. It covers the document, and only
the document. **A meta policy does not apply to a Web Worker**, which takes its
own policy from the HTTP response that served its script — and Toolshed
processes every file inside a worker. So on a host that cannot send headers,
the code that touches your files has no browser-enforced egress control. The
runtime network guard and the lint rules still apply there; they are the weaker
two of the three measures, and [PRIVACY.md](PRIVACY.md) says so plainly.

Two header files are in the repository, covering the hosts that read them:

| Host                     | File              | What it needs                                                        |
| ------------------------ | ----------------- | -------------------------------------------------------------------- |
| Netlify                  | `public/_headers` | nothing; the file is copied into `dist/` and read from there         |
| Cloudflare Pages         | `public/_headers` | nothing; same file, same place                                       |
| Vercel                   | `vercel.json`     | nothing; it sits at the repository root where Vercel looks           |
| GitHub Pages             | —                 | cannot send headers at all; see below                                |
| nginx, Caddy, Apache, S3 | —                 | copy the policy out of `public/_headers` into your own configuration |

Both files send the policy on `/*` rather than on the document alone, which is
what extends it to the workers. If you are writing your own server
configuration, do the same: a header on the HTML and nothing else looks right
and protects the one place that needs it least.

`test/buildInvariants.test.ts` compares the three copies of the policy against
each other on every test run, so a directive added to one and forgotten in
another fails the build rather than shipping a gap.

## GitHub Pages

GitHub Pages serves static files and offers no way to set a response header.
Everything works — the app loads, the tools run, it installs and it works
offline — but the dedicated workers where your files are decoded and encoded
run without a Content-Security-Policy, because the only copy of the policy that
reaches the browser is the meta tag on the document, and a worker does not
inherit it.

That is a real reduction in what the deployment can promise, not a technicality.
If you are hosting a copy for other people, prefer a host that can send headers.
If GitHub Pages is what you have, say so where your users can see it.

## Verifying a deployment

Three checks, in increasing order of how much they prove:

1. Open the page, then `curl -sI https://your.host/ | grep -i content-security`.
   If nothing comes back, you are on the meta tag alone and the paragraph above
   applies to you.
2. Open devtools, go to the Network tab, and put a file through a tool. There
   are no requests to anywhere but your own origin.
3. Load the page, disconnect from the network entirely, and keep working. The
   app opens from cache; each tool works offline once you have used it once.
