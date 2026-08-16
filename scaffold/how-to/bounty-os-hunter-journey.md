# How to: the hunter's path — find work, apply, sign, get paid

Everything a person does between *seeing* a bounty and *being paid* for it, and what to
check when a step does not happen. The operator side of contracting is
[agreements-and-signing](agreements-and-signing.md); the money ledger and its exact states
are [bug-bounty](bug-bounty.md). This is the surface the hunter actually touches.

## The one URL

**https://heyiris.io/p/bounty** — the gate, the dashboard, the open bounties and the Apply
buttons are all this page. There is no separate signup page, apply page, or payout page,
and that is deliberate: every extra page was somewhere people stopped.

## The chain, and which piece owns each step

| Step | Where it lives | Refuses with |
|---|---|---|
| Prove who you are | atlas email gate, `requireOtp: true` | 401 until a code is answered |
| See what you are owed | `GET /v1/bounty/gated` → `HunterDashboardService` | 401 unproven · 200 + empty if new |
| Enter a bug bounty | `POST /v1/public/bug-report` (no auth) | — reporting IS entry |
| Apply to a gig | `POST /v1/bounty/opportunities/{id}/apply` | 401 unproven · 422 doomed · 400 already applied |
| Get the paperwork | `ApplicantAgreementIssuer` on acceptance | logs, never blocks the hiring decision |
| Sign it | `/p/sign?t=…` from the email or the dashboard | link is a bearer credential |
| Be assigned | `OpportunityAccessGate` | withholds assignment, fails closed |
| Get paid | `GatedEarningsController` → `EarningsController` | 401 unproven · 409 no account |

## Two entry modes, and do not confuse them

A **bug bounty** is entered by REPORTING. There is no application and no NDA gate — you
file a bug, it gets verified, it pays from the pool. `/p/bounty` deliberately renders **no
Apply button** on those cards, because applying is not how you get in.

A **gig / FDE / task** is entered by APPLYING. That is the chain with acceptance,
agreements and assignment behind it.

`Opportunity::isBugBounty()` is the discriminator; the model surfaces `bug_report_count`
rather than `application_count` for exactly this reason.

## Applying without an account

The page advertises gigs to people who have proved an email and nothing else, so the apply
endpoint creates the account it needs, via `CheckoutService::createGuestUser` — the same
passwordless path guest checkout has always used.

Only on an **OTP-proven** session. A frictionless capture session would let anyone mint
accounts on other people's addresses from a public form. And the endpoint takes no other
identity input: a `user_id` in the body is ignored, with a test that applies carrying a
victim's id and asserts nothing lands under them.

The response carries `data.accountCreated`, and the card says *"Applied — and we set up
your account on this email."* Somebody discovering later that an account exists in their
name is a surprise that reads as a breach.

**Checks that cannot succeed run BEFORE signup** — opportunity gone, deadline passed,
membership gate — so a doomed application never leaves an orphan account behind.

## The membership gate that catches people out

`iris opportunities create --bounty` auto-creates a `<title> — Creators` program (slug
`bounty-<id>`) and gates applications to its members. That is right for clip campaigns and
wrong for engineering gigs: a brand-new account cannot be a confirmed member of anything,
so a gig with `program_id` set is **un-applyable to any new hunter**.

    iris opportunities get <id> --json | grep program_id     # is it gated?
    iris opportunities update <id> --program-id 0            # un-gate it

Check this first when Apply refuses and the reason mentions a program. It is a side effect
of the auto-program feature, not a rule anybody chose.

## Getting paid without a platform token

Payout setup and cashout run through the same proof. `GatedEarningsController` resolves the
hunter and hands them to the untouched `EarningsController` — money never gets a second
implementation of "who is being paid".

A proven address with no account gets **409 with a reason**, not a 401. Someone who just
answered a code is as signed in as the page can make them; "sign in" would loop forever.

## When a step does not happen

**"Your bounties could not be loaded"** — a real fetch failure. Not the same as the sign-in
prompt, which says so in those words. Check `/api/v1/bounty/me` in the network tab: the
iris-api proxy forks on the credential, sending a cookie session to `/bounty/gated` and a
Bearer token to `/bounty/me`.

**Signed in but the dashboard is empty** — read the identity line. It names the address the
page was answered for. `$0.00` under the wrong address looks identical to `$0.00` under the
right one, which is why the line exists.

**Accepted but never assigned** — by design. Acceptance is a hiring decision and proceeds;
ASSIGNMENT is what the agreement gate withholds. `iris agreements list --subject
opportunity_application:<id>` shows what is outstanding.

**No acceptance email** — `ApplicantAgreementIssuer` logs and never throws, because
paperwork must not break a hiring decision. Look for `[ApplicantAgreementIssuer]` in the
fl-api log rather than assuming it did not run.

## Verifying any of this for real

The gate is real, so drive it: enter the address, then read the code back with

    railway ssh -s fl-api -- php artisan atlas:otp-peek <bloqId> <email> --force

`iris mail` cannot do this (#180412). Do not verify by bypassing the gate with
`?atlas_token=` — that is the one path no customer uses, and three production bugs hid
behind it for seven weeks.
