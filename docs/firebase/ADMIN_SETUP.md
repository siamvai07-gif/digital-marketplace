# Admin Setup (one-time, required)

The admin console now uses **real Firebase Authentication**. The old client-side
access-key digest is gone — it was only a UI barrier, because anyone could call the
same database paths directly with the public API key.

## 1. Enable the providers

Firebase Console → project `banglabet-blitz` → **Authentication → Sign-in method**:

| Provider | Why | Required? |
|---|---|---|
| **Email/Password** | Customer login + admin login | **Yes** |
| **Anonymous** | Rules require `auth != null`; phone/guest customers have no email account | **Yes** |

Without Anonymous enabled, reads and writes fail for every user who signed in by
phone or as a guest. The app requests an anonymous session automatically on load.

## 2. Create the admin account

Authentication → **Users → Add user** → enter the admin email and a strong password.
Then copy the new user's **UID**.

## 3. Grant the admin claim

The rules trust `auth.token.admin === true`. Only the Admin SDK can set it, so this
must run once from a trusted machine (not the browser):

```bash
npm i -g firebase-tools
firebase login
firebase use banglabet-blitz
cd functions        # or any dir with admin-sdk access
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
node -e "
const admin = require('firebase-admin');
admin.initializeApp();
admin.auth().setCustomUserClaims('PASTE_ADMIN_UID', { admin: true })
  .then(() => { console.log('claim set'); process.exit(0); });
"
```

The user must sign out and back in (or wait up to 1 hour) for the claim to appear in
their token. `verifyAdminKey()` reads the claim from a fresh `getIdTokenResult()`, so
a re-login is enough.

Download the service account key from
**Project settings → Service accounts → Generate new private key**.

## 4. Sign in

Open `/admin`, enter the admin email + password. A non-admin account is rejected
even with a correct password.

## What is still client-side

Wallet crediting is performed by the admin console when an operator approves a
pending deposit (the same operation the old panel did). Rules restrict *who* can do
it — only the admin claim — and constrain field shapes, but a balance delta cannot be
validated by RTDB rules. Moving that to a Cloud Function is the remaining hardening
step and requires a paid Firebase plan (Blaze) for outbound/Cloud Functions usage.
