---
category: Bounty & Community
level: beginner
tags: [bounty, hunters, payments, community]
duration_min: 12
prerequisites: [bug-bounty]
---
# How to: the hunter's path — find work, apply, sign, get paid

Everything a person does between *seeing* a bounty and *being paid* for it, and what to
check when a step does not happen. The operator side of contracting is
[agreements-and-signing](agreements-and-signing.md); the money ledger and its exact states
are [bug-bounty](bug-bounty.md). This is the surface the hunter actually touches.

## The one URL

**https://heyiris.io/p/bounty-dashboard** — the gate, the dashboard, the open bounties and
the Apply buttons are all this page.

The page is now **tabbed**: *Your work* / *Find work* / *Certification*, and the tab is in the
URL hash. That is not decoration — **link a held payout straight at
`/p/bounty-dashboard#certification`**. Certification gates payment, so the difference between
somebody clearing it in half an hour and asking where their money went is usually whether the
notification pointed at the tab or at the page. (`/p/bounty` is a legacy alias serving the same page:
pages have no slug-redirect mechanism and that URL is already in sent emails, so it is kept
rather than retired.) There is no separate signup page, apply page, or payout page,
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
| Get certified | `GET/POST /v1/bounty/training/chapters/{id}` → `CourseService` | 401 unproven · 409 no account |
| Read what the listing requires | `sops[]` on the opportunity → acknowledge | 422 if it points at no content |
| Be paid | `CertificationGate` in `AwardService` | **holds** the money until certified — never voids it |
| Get paid | `GatedEarningsController` → `EarningsController` | 401 unproven · 409 no account |

## Two entry modes, and do not confuse them

A **bug bounty** is entered by REPORTING. There is no application and no NDA gate — you
file a bug, it gets verified, it pays from the pool. The dashboard deliberately renders **no
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

## The certification, and what it is NOT

The course is four modules — scope, severity, report quality, and what to do when you see
patient data. It is real: `Course` / `CourseChapter` / `CourseProgress` / `CourseCertificate`
have existed for months, the quiz is scored server-side by `CourseService::submitQuiz`, and the
badge is verifiable by anyone at `/p/verify-certificate?id=<uuid>` without an account.

Seed or revise it with `php artisan bounty:seed-training`. It is idempotent, matches on program
slug then chapter `display_order`, and **never deletes a chapter** — progress and issued
certificates hang off chapter ids, so replacing them would silently orphan every hunter's
record. Edit the copy in `SeedBountyTraining::chapters()` and re-run.

Courses can also be built through the platform now, rather than only from a shell:
`iris course create`, `iris course chapters add`, `iris course get`. See
[certification-courses](certification-courses.md).

**IT IS A GATE — this changed, and an earlier version of this page said the opposite.**
Certification now blocks PAYOUT. It is enforced by `CertificationGate` inside
`AwardService`, and separately in `BountyRewardService::processPayouts` for the creator/UGC
rail, which does not route through AwardService. Money already accrued is **held**, not voided:
the moment somebody certifies, the next run pays them for work already accepted.

Three things about the gate that are deliberate and worth not re-litigating by accident:

- **It never gates REPORTING or applying on a bug bounty.** Making it harder to tell us about a
  live vulnerability in order to enforce training is a net security loss and is unenforceable
  anyway — a hunter who cannot file simply emails it, or does not. Held at payout instead:
  costs us nothing, costs them about 35 self-serve minutes.
- **It is default-ON for bug bounties**, per an explicit operator decision. A listing that names
  no course is still gated by the platform hunter certification. A gig-style listing gates only
  when it names one, via `opportunities.required_certification_course_id`.
- **`nextStep` still ranks certification BELOW an unclaimed balance.** Telling somebody to go
  and sit a quiz while their money sits unmentioned is how a dashboard loses trust — and that
  reasoning survives the gate rather than being overturned by it.

**It is also not an agreement.** Same shape — an obligation before access — but a different
thing: a document you sign has a ledger, an audit trail and revocation semantics that a quiz
does not. They meet on the dashboard, not in `AgreementService::REQUIREMENTS`.

**The answer key never leaves the server.** Questions are served through
`HunterTraining::publicQuestions()`, which strips `correct`. If you add a question path, go
through that method — a quiz that ships its own answers is a form, and this one gates a
certificate saying somebody knows what to do with PHI.

## When a step does not happen

**"Your bounties could not be loaded"** — a real fetch failure. Not the same as the sign-in
prompt, which says so in those words. Check `/api/v1/bounty/me` in the network tab: the
iris-api proxy forks on the credential, sending a cookie session to `/bounty/gated` and a
Bearer token to `/bounty/me`.

**Signed in but the dashboard is empty** — read the identity line. It names the address the
page was answered for. `$0.00` under the wrong address looks identical to `$0.00` under the
right one, which is why the line exists.

**The modules render but none of them open** — the iris-api proxy is per-path, not a
wildcard. `/v1/bounty/training/chapters/{id}` and its `/quiz` twin each need a route in
`fl-iris-api/routes/api.php`, or the fetch 404s same-origin while the upstream is fine.

**No training section at all** — `bounty:seed-training` has not been run in that
environment. `training` comes back `null` and the section is omitted rather than emptied,
which is deliberate: an empty course is worse than no course.

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
