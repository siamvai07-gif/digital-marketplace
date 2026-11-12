# Admin Access Setup

Admin login is **one access key**. No admin account to create, no Admin SDK, no
service account, no paid services.

## How it works

The access key is the password of a dedicated Firebase Auth account:

```
email:    admin@nexusdigital.app   (a username, not a secret)
password: <your access key>
```

- The key is **never** in the HTML/JS bundle — it exists only in the login input and
  in Firebase's credential store.
- Google verifies it **server-side**. There is no offline hash to crack.
- Database rules trust that account's email in the ID token
  (`auth.token.email === 'admin@nexusdigital.app'`). Only the holder of the correct
  key can obtain such a token, so this is as strong as a custom claim — but requires
  no Admin SDK to mint anything.

## First-time use

Nothing to create. On the first login attempt the panel tries to sign in; if the
account does not exist yet it **creates it automatically using the key you typed**.
So the first successful login both provisions the admin account and unlocks the
console. Only someone who knows the key can ever set that password.

> If an admin account already exists with a *different* password, the typed key is
> rejected (lockout applies). Reset it in Firebase Console → Authentication → Users.

## What you need enabled in Firebase

| Provider | Why |
|---|---|
| **Email/Password** | Admin key login + customer email login |
| **Anonymous** | Rules require `auth != null`; phone/guest customers have no email |

Both are on the free Spark plan.

## Rules

Paste `docs/firebase/rules.proposed.json` into Realtime Database → Rules → Publish.
The admin email appears there and must match `ADMIN_AUTH_EMAIL` in `admin/index.html`.
A test enforces that they stay in sync.

## Known limit

Wallet balance deltas cannot be validated by Realtime Database rules. The rules
restrict *who* may write balances (the admin account only) and constrain the value
(`>= 0`), but an admin can set any amount. This is inherent to client-performed
wallet updates; closing it fully requires server-side code, which needs a paid
Firebase plan. The payment flow itself is honest: customer top-ups are stored as
`PENDING` and require admin verification of the TrxID before crediting.
