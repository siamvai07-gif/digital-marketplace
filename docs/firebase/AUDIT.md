# Firebase Identification & Proposed Rules

**Status: read-only audit. Nothing in this document has been applied. No files outside `docs/firebase/` were changed.**

---

## 1. Exact Firebase Project Identity

Verbatim from `index.html:2786` and `admin/index.html:984` — the two blocks are **byte-identical**:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyD-Ijy5bF1RFpwCbEiZEHyFPdMOjeEbAE4",
  authDomain: "gen-lang-client-0247496189.firebaseapp.com",
  databaseURL: "https://gen-lang-client-0247496189-default-rtdb.firebaseio.com",
  projectId: "gen-lang-client-0247496189",
  storageBucket: "gen-lang-client-0247496189.firebasestorage.app",
  messagingSenderId: "75421939355",
  appId: "1:75421939355:web:cebfd39dcf1f20c727f83e"
};
```

| Field | Value |
|---|---|
| **Project ID** | `gen-lang-client-0247496189` |
| **Database URL** | `https://gen-lang-client-0247496189-default-rtdb.firebaseio.com` |
| Database region | `us-central1` (default shard, inferred from `-default-rtdb`) |
| Auth domain | `gen-lang-client-0247496189.firebaseapp.com` |
| Storage bucket | `gen-lang-client-0247496189.firebasestorage.app` |
| Messaging sender | `75421939355` |
| App ID | `1:75421939355:web:cebfd39dcf1f20c727f83e` |
| API key | `AIzaSyD-Ijy5bF1RFpwCbEiZEHyFPdMOjeEbAE4` |

**Important:** the `gen-lang-client-*` prefix means this is a **Google AI Studio auto-provisioned
project**, not a purpose-created Firebase project. There is no `.firebaserc`, no `firebase.json`,
and no Firebase CLI linkage in the repo — so nothing here is version-controlled by Firebase
tooling. Config lives only inside the two HTML files.

The API key is **not a secret** (Firebase web keys are public identifiers); the security boundary
is the database rules and Auth authorized-domains. The key that *was* a problem —
`AIzaSyAiByTzOZNcGBlti12VcU24kuGelfmjhmrc` — leaked in the deleted prototype HTML files and is
still reachable in git history. It should be revoked in Google Cloud Console regardless of the
rest of this plan.

---

## 2. Connected Services

| Service | State | Evidence |
|---|---|---|
| **Realtime Database** | **IN USE — primary data store** | `firebase-database.js` v8.10.1 loaded; every read/write in both apps |
| **Authentication** | **IN USE (email/password only)** | `signInWithEmailAndPassword` (`index.html:4585`), `createUserWithEmailAndPassword` (`:4686`), `signOut` (`:4754`) |
| **Hosting** | NOT USED | deploying to Netlify |
| **Firestore** | NOT USED | 0 references in either file |
| **Cloud Storage** | NOT USED | 0 references; images are remote URLs / `public/assets` |
| **Cloud Messaging / Analytics / Crashlytics / App Check** | NOT USED | 0 references, SDKs not loaded |
| **Cloud Functions** | NOT USED | no `functions/` directory, nothing invoked |
| **Firebase Auth in admin console** | **NOT USED** | admin initializes `firebase.auth()` but never calls it — gate is a client-side digest |

SDKs loaded, all v8.10.1 legacy compat from `gstatic.com`:
`firebase-app.js`, `firebase-database.js`, `firebase-auth.js`.

**Auth providers actually referenced:** email/password only. There is **no** Google, Facebook,
phone/SMS, or anonymous provider anywhere in the code. So the only provider that must be enabled
in the Firebase console is **Email/Password**.

Also absent: `onAuthStateChanged` (0 uses), `sendPasswordResetEmail`, `sendEmailVerification`,
`setPersistence`, custom claims. **There is no "forgot password" flow.** Sessions are established
purely by writing the customer profile to `localStorage` (`nx_user`), not by an auth listener.

---

## 3. Actual Database Structure (derived from code)

This is the schema the rules must fit. Confirmed by enumerating every `DB.ref(...)` call site.

| Node | Read by | Written by | Notes |
|---|---|---|---|
| `products` | customer (public), admin | admin only | `update`, `set`, `remove` |
| `settings` (+ `brand`, `contact`, `announcement`, `heroVideo`, `dollarRates`, `coupons`, `paymentNumbers`, `paymentAccounts`) | customer (whole node, `:6342`), admin | admin only | payment numbers are public by design |
| `reviews` | customer (public), admin | customer `push` + admin `set`/`update`/`remove` | customer submits review with `verified:true` client-side |
| `customers/$id` | customer (self) + **whole-node scans for login** | customer (self) + admin | contains `passwordHash`, `walletCoins`, `status` |
| `orders` | customer **whole-node scan, filtered client-side** (`:4194`), admin | customer `push`, admin `update`/`remove` | |
| `addFunds` | customer **whole-node scan** (`:5493`), admin | customer `push`, admin `update` | |
| `deposits` | admin | customer `push` (dual-write), admin `update` | legacy twin of `addFunds` |
| `cashouts` | admin | customer `push`, admin `update` | |
| `dollarRequests` | admin | customer `push`, admin `update` | |
| `transactions` | **nobody reads** | customer + admin `push` | write-only audit ledger, never displayed |
| `admin/config/key` | — | — | **does not exist in this codebase** |

Correction to an earlier assumption of mine: `admin/config/key` is **not** in this repo. The admin
key is a hardcoded digest, `ADMIN_KEY_HASH = 'p1ww0kqsb4rt34h'` (`admin/index.html:881`), verified
client-side. So that particular leak vector does not apply — but the hardcoded-digest gate is
still not a security boundary, because *every* RTDB operation it guards is performed by an
unauthenticated client. Whoever can load `/admin` can call the same paths directly.

### The structural blocker

Four code paths require **unauthenticated whole-node reads**, which no secure rule set can permit:

1. `findCustomerByIdentifier` — `DB.ref('customers').once('value')`, scans every customer to match
   an email/phone (`index.html:4516`). This is why `passwordHash` is currently world-readable.
2. Duplicate-signup guard — `DB.ref('customers').once('value')` again (`:4708`).
3. Order history — `DB.ref('orders').once('value')`, filters to the current user in JS (`:4194`).
4. Add-funds history — `DB.ref('addFunds').once('value')`, same pattern (`:5493`).

`customers` and `orders` hold the entire customer base and all order history. Locking them down
**will break login, signup, order history, and the funds-history screen** until those reads move
from "read everything, filter in the browser" to "read only my own subtree."

That is the real content of Phase 2, and it is why the rules below are **not** drop-in.

---

## 4. Proposed Rules

File: `docs/firebase/rules.proposed.json` (JSON, ready to paste into the console after Phase 2).

Design intent:

- **Default deny** at root. Nothing is readable or writable unless a rule says so.
- `products`, `settings` — public read, **no client writes**. Admin mutations move to a backend
  function holding the Admin SDK. This alone kills the "anyone can rewrite prices / payment
  numbers" hole.
- `reviews` — public read; a signed-in user may create exactly one review keyed to their own
  `authorId`, with server-side validation of rating range and text length. No client may set
  `status: 'APPROVED'` or `verified: true` — those become admin-only. No edits, no deletes.
- `customers/$uid` — a user may read **only their own** record. **No client write at all**;
  balances, `status`, and `passwordHash` are backend-only. This closes the "set your own
  `walletCoins` to 999999" hole.
- `byUser/$uid/...` — **new node required by Phase 2.** A per-user index so the customer app can
  read its own orders / addFunds / cashouts / dollarRequests without scanning the global
  collections. Writes to it are backend-only (the backend mirrors on create).
- `orders`, `addFunds`, `deposits`, `cashouts`, `dollarRequests`, `transactions` — readable only by
  an admin custom claim (`auth.token.admin === true`); **no client writes**.
- `admin` — denied outright.

### Two required prerequisites

1. **Custom claims.** `auth.token.admin === true` requires a one-time backend script using the
   Admin SDK to set the claim on the admin account, plus the admin console signing in to Firebase
   Auth (it currently does not — this is a new login flow, replacing the hardcoded digest).
2. **No `orderByChild` indexes needed.** The app deliberately avoids queries ("an `orderByChild()`
   query would require an `.indexOn` rule, and fails with a permission error when it is missing" —
   `index.html:4192`). Since all filtering moves to the backend or to `byUser`, **no `.indexOn` is
   required** and no existing data needs restructuring beyond the additive `byUser` mirror.

### What breaks if applied today

Applied as-is *before* Phase 2, the site breaks in five places: login by email/phone, signup
duplicate-check, order history, funds history, and all admin writes. This is expected — the rules
encode the target architecture, not the current one. **Do not paste these into the console until
Phase 2 is shipped.**

---

## 5. What I Could Not Verify

Sandbox egress to Google is blocked — `*.firebaseio.com`, `identitytoolkit.googleapis.com`, and
`*.firebaseapp.com` all return HTTP `000` (`SSL_ERROR_SYSCALL`). Therefore:

- **Current live rule state is unknown.** It may already be permissive (likely, given the code
  works) or already locked down (which would mean the app is broken in production right now).
- **Which auth providers are enabled is unknown.** Code only needs Email/Password, but the console
  may have Google/phone enabled and unused.
- **Whether Realtime Database even exists on that shard is unknown.** The URL is correct in the
  config, but an AI Studio project can be created without ever provisioning RTDB.
- **Live data volume is unknown** — relevant to whether the `customers` whole-node read is merely
  insecure or also a performance problem.

These four need one look at the Firebase console. They cannot be answered from the repo.

---

## 6. Awaiting Approval

Phase 2 as I would sequence it — no work starts until you say go:

1. Add `byUser` mirroring in the backend; move order/funds history reads to it.
2. Move login + duplicate-check to backend endpoints (Admin SDK), so `customers` closes to
   self-read-only.
3. Move wallet credit/debit, order creation, and payment approval into backend functions.
4. Give the admin console a real Firebase Auth login with an `admin` custom claim.
5. Only then apply `docs/firebase/rules.proposed.json`.
6. Keep bKash/Nagad manual: admin verifies the TrxID by hand, backend credits the wallet. Remove
   the simulated 5-digit PIN + auto-`COMPLETED` path at `index.html:5235`-`5282`, which currently
   marks payments `GATEWAY_AUTO_VERIFIED` / `COMPLETED` without any gateway contact.

Say the word and I'll start on step 1.
