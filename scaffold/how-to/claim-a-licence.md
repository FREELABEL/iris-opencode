---
category: Getting Started
level: beginner
tags: [licence, license, key, seat, claim, activate, desktop, cli]
duration_min: 5
---
# How to: Claim your IRIS licence key

## What this does

A licence key looks like `IRIS-XXXX-XXXX-XXXX`. Claiming it gives your IRIS account a seat on that licence. You can claim it while signing in to IRIS Desktop, or from the terminal once you are signed in. It takes a couple of minutes either way.

## Before you start

- Your licence key, from whoever arranged your IRIS access.
- Access to the email inbox for the address you will sign in with. The key is only applied once you have entered the code sent to that inbox.
- For the terminal steps, IRIS installed and signed in with `iris auth login`.

Keep the key private. Anyone who has it can use it to take a seat.

## Step 1: Claim it in IRIS Desktop

Use this when you are signing in to Desktop for the first time.

1. Enter your email address.
2. Choose **Have a trial code or licence key?** and paste your key.
3. Send the code. Desktop tells you:

```
Licence key accepted. It will be applied when you enter the code from your email.
```

4. Enter the 6-digit code from your email and sign in. This is the moment the key is claimed.

**Continue with Google** does not take a key. If you signed in that way, claim it from the terminal in Step 2.

## Step 2: Or claim it from the terminal

Use this if you are already signed in.

```bash
iris licence claim IRIS-XXXX-XXXX-XXXX
```

```
Claimed — pro active
```

Claiming a licence you already hold a seat on is safe: it succeeds and takes no second seat. If a claim is refused, the command prints the reason and exits non-zero, so a script can tell.

## Step 3: Check your licence

```bash
iris licence me
```

```
◈  Your licence
  ────────────────────────────────────────────────────────────
  tier:  pro
  status:  active
  seats:  14
  expires:  2027-01-29T12:00:00+00:00
  ────────────────────────────────────────────────────────────
iris licence me --json for the machine-readable form
```

`seats` is how many people the licence covers, not how many you hold. `expires` reads `never` when the licence has no date of its own, as with one that follows a paid subscription.

## What happens when a licence ends

A licence with a date stops working when that date passes. One tied to a subscription ends with the subscription, and an operator can revoke any licence. After that:

- `iris licence me` says `No active licence on this account.`
- The licence stops counting towards features that need one, so you may be asked to choose a plan.
- Your account stays, and you can still sign in.
- The key can no longer be claimed.

To carry on, ask whoever gave you the key for a new one and claim it the same way.

## Common problems

**`That licence key was not found.`** Check it for typos. Keys never contain 0, O, 1, I or L.

**`This licence has no seats left (14 of 14 in use).`** Everyone the licence covers has claimed it. Ask whoever gave you the key.

**`This licence has been revoked.` or `This licence expired on …`** The key no longer works. Ask for a new one.

**You signed in on Desktop but `iris licence me` shows no licence.** The licence may have changed between sending the code and entering it, in which case sign-in still succeeds without it. Run `iris licence claim <key>` to see the reason.

**Your code expired before you used it.** The key is held only as long as the code. Send a new code with the key filled in. A new code sent without the key drops it.

## Related

- `iris-login.md`: sign in to the IRIS CLI
- `team-licences.md`: issue a licence for a whole team
