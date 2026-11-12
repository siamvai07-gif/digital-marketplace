# NEXUS DIGITAL — Digital Marketplace & Dollar Exchange

Instant dollar buy/sell, game top-ups (Free Fire / PUBG), gift cards, subscriptions
and a prepaid coin wallet, backed by Firebase Realtime Database.

Two entry points, both static HTML:

| Path     | What it is                        |
| -------- | --------------------------------- |
| `/`      | Customer storefront               |
| `/admin` | Operator console (access-key gate) |

---

## Deploying to Netlify

The site is a **static Vite build**. There is no Node server, no serverless
function and no build-time secret. `server.ts` exists only as a local dev
convenience and is never used by Netlify.

1. Connect the repository in Netlify. `netlify.toml` already supplies everything:
   - **Build command:** `npm run lint && npm run build`
   - **Publish directory:** `dist`
   - **Node:** `22` (Vite 8 requires `^20.19 || >=22.12`)
2. Deploy. No environment variables are required.

### Why those settings

- `npm run lint` is part of the build so a type error or a broken Vite config
  fails the deploy instead of publishing a blank page.
- `NPM_FLAGS = --include=dev` guarantees `vite`/`typescript` install even if the
  build image exports `NODE_ENV=production`; without it the build fails with
  `vite: not found`.
- `NODE_VERSION = 22` prevents the image from resolving an unsupported Node.

### Routing

Netlify serves a matching static file *before* applying a 200-status rewrite,
which is what stops these rules from looping:

| From        | To                  | Why                                    |
| ----------- | ------------------- | -------------------------------------- |
| `/admin`    | `/admin/index.html` | console without a trailing slash       |
| `/admin/*`  | `/admin/index.html` | any deep admin path                    |
| `/*`        | `/index.html`       | SPA shell (the app is hash-routed)     |

`public/_redirects` mirrors these rules and is copied into `dist/` at build
time. A test asserts the two files stay identical — edit both or neither.

### Headers

`netlify.toml` sets immutable caching for `/assets/*`, revalidation for the HTML
entry points, and baseline security headers (`nosniff`, `SAMEORIGIN`,
`Referrer-Policy`, `Permissions-Policy`). `/admin` is marked `noindex`.

`X-Frame-Options` is `SAMEORIGIN`, deliberately **not** `DENY`, so the site can
still be shown in an embedded preview pane.

---

## Verifying a deployment

```bash
npm ci                 # clean, lockfile-exact install
npm run verify         # lint -> unit/E2E -> build -> deploy checks
```

`npm run verify` runs four things:

| Step              | What it proves                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `npm run lint`    | `tsc --noEmit` over the TS/Vite config                            |
| `npm test`        | 55 assertions driving the real storefront + admin in jsdom         |
| `npm run build`   | production bundle builds                                          |
| `npm run test:deploy` | 85 assertions: Netlify config + the **built** bundle end-to-end |

`test:deploy` parses the real `netlify.toml`, inspects the real `dist/`, replays
Netlify's routing/header engine for every public URL, then boots `dist/index.html`
and `dist/admin/index.html` and walks register → login → top-up → purchase →
admin fulfilment → customer delivery.

To sanity-check locally before pushing:

```bash
npm run build && npm run preview     # serves dist/ with the same rewrites
```

---

## Security notes

**The admin access key is not in the shipped bundle.** `admin/index.html`
compares a salted digest, applies a 5-attempt / 5-minute lockout, and expires
the session after 12 hours. A test fails the build if the literal key ever
reappears in published HTML.

**Two abandoned prototype pages were removed** from `public/assets/aistudio/`
(`admin_933a1e1c.html`, `user_71a316be.html`). They were unreferenced but
publicly served, hard-coded the admin key in plaintext, and wrote directly to the
live database. They remain in git history — if that history is ever made public,
treat the key as compromised and rotate it.

**The Firebase web config in the HTML is public by design.** A Firebase web API
key is a project identifier, not a secret; it is meant to ship in client code.
Access control is enforced by Firebase Security Rules and by restricting the key
in Google Cloud Console. Because wallet balances are mutated from the browser,
**the database rules — not this repo — are the real security boundary.** See
`.env.example` for a starting rule set and its documented limitations.

⚠️ The payment gateway screens (bKash/Nagad OTP + PIN) are a **UI simulator**:
the transaction ID is generated client-side and the wallet is credited locally.
No real payment is captured or verified. Before handling real money, move the
credit step behind a trusted server (Netlify Function or Firebase Cloud
Function) and reconcile against the provider's API.

---

## Project layout

```
index.html              storefront (inline CSS/JS, hash-routed)
admin/index.html        operator console
public/assets/          images + _redirects (copied verbatim into dist/)
server.ts               local dev server only (Vite middleware mode)
vite.config.ts          MPA build: main + admin entry points
netlify.toml            build, redirects, caching, security headers
tests/                  jsdom harness + E2E, Netlify config and deploy smoke tests
```

`src/` still contains the original React scaffold. It is not referenced by either
HTML entry point and is not part of the built output.
