---
category: Infrastructure
level: intermediate
tags: [integrations, organizations, credentials, tenancy, oauth, migration]
duration_min: 15
prerequisites: [iris-integrations]
---
# Share an integration with a team, instead of one person

By default a connected account belongs to **one user**. That does not survive
offboarding: when the person who connected the Drive leaves, the client's automation
stops, and the fix is another human pasting another credential.

This is how a credential belongs to an **organization** instead — so every member
inherits it, and nobody's personal token is quietly backing team work.

> **Read "Two databases" below before building a client-facing integrations page.**
> The scoping on this page lives in fl-api. The Genesis `IntegrationsGrid` reads a
> different table, in a different database, that has no scope at all.

## The resolution ladder

One credential is chosen per tool call, first match wins:

    1  PROJECT        integrations.bloq_id          shared with everyone on that project
    2  ORGANIZATION   integrations.organization_id  shared with the org's active members
    3  BRAND          integrations.brand_id         dormant — see "brand" below
    4  PERSONAL       integrations.user_id          GATED when the work is shared

The organization is derived from the **project**, never from the person. A contractor
may belong to two organizations; the bloq knows which one owns the work, the user does
not.

## Do it

```bash
# 1. an organization, with an owner seated in the same breath
php artisan organizations:manage create --name=Acme --user=you@example.com

# 2. the people
php artisan organizations:manage add-member --org=acme --user=teammate@example.com --role=member

# 3. the project it owns  (this is what makes the tier fire)
php artisan organizations:manage attach-bloq --org=acme --bloq=251

# 4. see it
php artisan organizations:manage show --org=acme
```

These run on **fl-api** (`railway ssh -s fl-api -- php artisan …`).

Then connect a credential **for** the organization, either in the Elon UI ("Connect for →
Acme" on the integrations modal) or via the API with `organization_id`.

> `railway ssh` flattens argv, so `--name="Two Words"` breaks. Use a single token.

## Prove it, rather than assume it

`resolveForContextFiltered()` returns an Integration and never says which tier produced
it — so "a credential came back" cannot distinguish the org tier working from the
personal tier quietly covering for it. Those are opposite outcomes.

```bash
php artisan integrations:prove-scope --list                    # what exists, per scope
php artisan integrations:prove-scope --user=193 --bloq=251     # which tier wins, and why
php artisan integrations:prove-scope --demo=251                # end-to-end, self-cleaning
```

`--demo` resolves **before** attaching the org and again after, then restores every
fixture. The before is the point: a check that only shows the success case cannot tell a
working tier from one that would have returned that row anyway.

## Rules that are not arbitrary

**Absent scope means personal, always.** Silence must never promote a credential to
shared — once an agent has acted with it, that direction cannot be undone.

**Connecting at org scope needs owner or admin**, not membership. It means "every member
may act as this account", which is a bigger grant than adding a person.

**`user_id` stays set on an org credential.** It records who connected it — the first
question anyone asks after an incident. Scope is decided by `organization_id`, not by the
absence of a user.

**OAuth `state` is carried, never trusted.** It is base64 and unsigned and passes through
a third party, so the role is re-read from the database when the callback lands. A failed
re-check still creates the credential, at *personal* scope, and logs the claim — throwing
away a completed OAuth would punish a user for a claim they may not have made.

## Why not a licence tier

A licence is a **commercial** boundary (who paid, how many seats). An organization is a
**membership** boundary (who works together). Credentials follow membership:

- a licence lapsing at month end would orphan live client credentials mid-project
- two licences for one company would split its credentials into two invisible pools
- a trial-to-paid transition would migrate credentials for no functional reason

They are usually the same shape, which is exactly why conflating them survives review —
they diverge only at renewal, upgrade, lapse and consolidation. A licence instead gates
*whether* an org may connect at all. See ADR-01 (#183593).

## Brand: dormant on purpose

Do not "fix" the brand tier by threading a `brandId` through `IntegrationRegistry`.

All brand-scoped integrations are `category='social'` and already resolve through
`Marketing\SocialAccountResolver`, which handles brand itself. Wiring the tier would
create a *second* resolver over the same rows, and two paths that can disagree about
which account a brand posts from is worse than a tier that never fires.

It becomes live work only when a brand-scoped integration exists that is **not** social.

## Two databases

The boundary is **fl-api = business data, iris-api = agentic data.** Credentials sit
across that line, and today they are stored on both sides of it.

| | `fl_api.integrations` | `iris_db.integrations` |
|---|---|---|
| Scope columns | `user_id` `brand_id` `bloq_id` `organization_id` | `user_id` only |
| Read by | `IntegrationRegistry`, `resolveForContextFiltered`, everything above | `/v1/creator/integrations` → the Genesis **`IntegrationsGrid`**, plus ~10 iris classes |

**Consequence:** a credential connected at organization scope is invisible to a Genesis
client dashboard. Wiring `organization_id` into `IntegrationsGrid` against the iris table
would build on a table that cannot hold it.

**The plan is to split the row set, not the system.** A credential's ownership, tenancy
and authorization are business facts → fl-api. Agent-facing service connections, model
keys and session capabilities are agentic → they stay in iris. Do **not** add scope
columns to `iris_db.integrations`: that duplicates the tenancy model in two schemas that
will drift, which is the failure this whole page exists to prevent.

### The two `organizations` tables are NOT duplicates

| | `fl_api.organizations` | `iris_db.organizations` |
|---|---|---|
| Key | bigint | uuid |
| Means | a **tenant** — our users who share credentials | an **external developer org** on the A2A platform, registering `external_agents` into threads |
| Live? | yes | yes — routed CRUD under `v1/organizations` |

Both sit on the correct side of the business/agentic line; they only share a noun. The
iris one was nearly deleted as a duplicate on 2026-09-07 — it would have broken A2A. Both
models carry a docblock warning. Never merge them.

### Size the consolidation before moving anything

Three **read-only** commands, run on **fl-iris-api**:

```bash
railway ssh -s fl-iris-api -- php artisan integrations:census           # what is in iris_db
railway ssh -s fl-iris-api -- php artisan integrations:overlap          # same accounts on both sides?
railway ssh -s fl-iris-api -- php artisan integrations:classify --rows  # business / agentic / ambiguous
```

Snapshot on 2026-09-07 (re-run; these drift):

    census     86 rows · 9 users · 0 empty credentials
    overlap    7 collisions · 32 only in iris · 9 only in fl_api · 34 iris rows with no email
    classify   60 business · 9 agentic · 17 ambiguous
               56 of the 60 business rows have no account_email

### How to read those numbers

- **Identity is `(type, account_email)`.** Not `id` — the tables have independent
  sequences, so equal ids mean nothing. Not `credentials` — they are encrypted under
  different app keys, so the same account has different ciphertext on each side, and
  comparing them reports zero overlap on a table that overlaps completely.
- **A collision on a blank email is not a match.** Six of the seven collisions were
  `(type, '')` on both sides — the same *type*, not provably the same *account*. With 56 of
  60 business rows lacking an email, "7 collisions" is a floor, not a total.
- **An unrecognised type is ambiguous, never defaulted.** Defaulting sends a client's Jira
  into the agent database, or an internal `staff-management` service into the tenant
  credential store — and neither throws. The type map in `IntegrationsClassify` is a
  judgement, stated in one place so it can be argued with.

### Order of operations

    1. rule on the ambiguous types            (vapi · macos · google-gemini are genuinely on the line)
    2. backfill account_email on iris rows    the blocker — without it overlap is unknowable
    3. re-run integrations:overlap            now the collision count is real
    4. decide a winner rule for collisions
    5. move BUSINESS rows only, no dual writes
    6. point the creator path at fl_api for credentials
    7. drop the iris copy once nothing reads it

As of 2026-09-07 **nothing has moved**. Steps 1–2 are open.

## Gotchas

- **Org membership needs a platform IRIS account.** An Atlas portal role is not enough —
  `add-member` will report the user as not found. The creator path resolves an atlas
  session to a platform user id, and treats "proven email, no account" as a separate case.
- **Uniqueness is per scope.** A personal Drive and an org Drive coexist. (Before
  2026-09-05 it was `(user_id, type)` with no scope, so connecting your org's Drive was
  refused as a duplicate of your own.)
- **Deleting an org that owns credentials is refused**, and `--force` does not waive it —
  the rows would point at an organization that resolves to nothing and the credential
  would go invisible with no error.
- **A duplicate in `fl_api.integrations` does not error.** Strict resolution throws
  `IntegrationAmbiguousException`; the default quietly takes the first row. Never migrate
  blind.
- **`db:table integrations` cannot count rows on the iris container.** It dies on
  `The "intl" PHP extension is required to use the [format] method` while formatting the
  table size — after the column count, before the row count. Use `integrations:census`.
- **"Zero references" needs routes checked too.** A grep over models alone reported the
  iris `organizations` table as unused; two routed controllers use it.

## Related

Epic: `/p/epic-integration-tenancy` · #183590 #183591 #183592 #183593 ·
`iris how-to view iris-integrations`
