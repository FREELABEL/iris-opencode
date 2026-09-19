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

```svg
<svg viewBox="0 0 640 300" width="100%" role="img" aria-label="The four-tier credential ladder: project, organization, brand, personal. First match wins.">
  <text x="0" y="16" class="sv-head" font-size="15">One tool call · first match wins · stop at the first row that has a credential</text>

  <rect x="0" y="34" width="640" height="44" rx="6" class="sv-box"/>
  <text x="16" y="55" class="sv-k" font-size="13">1 · PROJECT</text>
  <text x="16" y="71" class="sv-v" font-size="12">integrations.bloq_id — everyone on that project</text>
  <text x="624" y="62" class="sv-cap" font-size="12" text-anchor="end">empty here → fall through</text>

  <rect x="0" y="86" width="640" height="44" rx="6" class="sv-good"/>
  <text x="16" y="107" class="sv-good-t" font-size="13">2 · ORGANIZATION</text>
  <text x="16" y="123" class="sv-good-t" font-size="12">integrations.organization_id — the org's active members</text>
  <text x="624" y="114" class="sv-good-t" font-size="12" text-anchor="end">MATCH — stop</text>

  <rect x="0" y="138" width="640" height="44" rx="6" class="sv-box"/>
  <text x="16" y="159" class="sv-k" font-size="13">3 · BRAND</text>
  <text x="16" y="175" class="sv-v" font-size="12">integrations.brand_id — dormant, social resolves elsewhere</text>
  <text x="624" y="166" class="sv-cap" font-size="12" text-anchor="end">never reached</text>

  <rect x="0" y="190" width="640" height="44" rx="6" class="sv-bad"/>
  <text x="16" y="211" class="sv-bad-t" font-size="13">4 · PERSONAL</text>
  <text x="16" y="227" class="sv-bad-t" font-size="12">integrations.user_id — one human's token</text>
  <text x="624" y="218" class="sv-bad-t" font-size="12" text-anchor="end">GATED when the work is shared</text>

  <text x="0" y="258" class="sv-cap" font-size="12">The organization is derived from the PROJECT, never from the person —</text>
  <text x="0" y="276" class="sv-cap" font-size="12">a contractor in two orgs does not get to pick which client's credential runs.</text>
  <text x="0" y="294" class="sv-cap" font-size="12">Absent scope always means personal. Silence must never promote a credential to shared.</text>
</svg>
```

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

```svg
<svg viewBox="0 0 640 330" width="100%" role="img" aria-label="Two integrations tables in two databases holding largely disjoint populations, with one real duplicate between them.">
  <text x="0" y="16" class="sv-head" font-size="15">Two tables, one concept, two databases — measured 2026-09-12</text>

  <rect x="0" y="32" width="300" height="150" rx="6" class="sv-box"/>
  <text x="16" y="54" class="sv-k" font-size="13">fl_api.integrations</text>
  <text x="16" y="74" class="sv-v" font-size="12">30 rows · HAS scope columns</text>
  <text x="16" y="94" class="sv-v" font-size="12">user_id · brand_id · bloq_id</text>
  <text x="16" y="110" class="sv-v" font-size="12">organization_id</text>
  <text x="16" y="134" class="sv-cap" font-size="12">16 are social-* brand rows that</text>
  <text x="16" y="150" class="sv-cap" font-size="12">never had an iris counterpart</text>
  <text x="16" y="170" class="sv-cap" font-size="12">read by IntegrationRegistry</text>

  <rect x="340" y="32" width="300" height="150" rx="6" class="sv-box"/>
  <text x="356" y="54" class="sv-k" font-size="13">iris_db.integrations</text>
  <text x="356" y="74" class="sv-v" font-size="12">92 rows · user_id ONLY</text>
  <text x="356" y="94" class="sv-bad-t" font-size="12">no organization_id · no bloq_id</text>
  <text x="356" y="118" class="sv-cap" font-size="12">59 Composio-backed user rows</text>
  <text x="356" y="138" class="sv-cap" font-size="12">read by /v1/creator/integrations</text>
  <text x="356" y="154" class="sv-cap" font-size="12">→ the Genesis IntegrationsGrid</text>
  <text x="356" y="174" class="sv-cap" font-size="12">+ ~10 iris classes</text>

  <line x1="300" y1="107" x2="340" y2="107" class="sv-line"/>
  <text x="320" y="200" class="sv-cap" font-size="12" text-anchor="middle">1 real duplicate</text>
  <text x="320" y="216" class="sv-cap" font-size="12" text-anchor="middle">google-drive</text>

  <rect x="0" y="238" width="640" height="46" rx="6" class="sv-bad"/>
  <text x="16" y="258" class="sv-bad-t" font-size="13">A credential shared with an org is INVISIBLE to a client dashboard.</text>
  <text x="16" y="276" class="sv-bad-t" font-size="12">The grid reads the table on the right, which has nowhere to put the scope.</text>

  <text x="0" y="308" class="sv-cap" font-size="12">Identity across the two is composio_connected_account_id first, then (type, account_email).</text>
  <text x="0" y="324" class="sv-cap" font-size="12">Never id — the sequences are independent. Never the credentials blob — different app keys.</text>
</svg>
```

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

All **read-only**, run on **fl-iris-api**:

```bash
railway ssh -s fl-iris-api -- php artisan integrations:census                 # what is in iris_db
railway ssh -s fl-iris-api -- php artisan integrations:overlap --explain      # same accounts on both sides?
railway ssh -s fl-iris-api -- php artisan integrations:classify --rows        # business / agentic / ambiguous
railway ssh -s fl-iris-api -- php artisan integrations:backfill-account-email --explain
```

Snapshot on 2026-09-12 (re-run; these drift):

    overlap    iris_db 92 rows   composio 59 · email  2 · NEITHER 31
               fl_api  30 rows   composio  3 · email  4 · NEITHER 23
               matched pairs 1 · only iris 91 · only fl_api 29
    classify   60 business · 9 agentic · 17 ambiguous
    backfill   0 of 87 emailless rows resolvable

### How to read those numbers

- **Identity is a ladder, matched in two passes.** First
  `composio_connected_account_id` — the same connected account carries the same id in both
  databases, it needs no backfill, and fl-api stores it plainly (it is *not* in fl-api's
  encrypted-field list). Then `(type, account_email)` over whatever is left.
  **Two passes, not one key per row**: a row identified by composio id must still be able
  to meet the same account identified by email on the other side. Keying each row by a
  single rung hid exactly that case — `amayo@mypathwaysai.com` matched on email, then
  vanished when the composio rung was added.
- **Never `id`** — independent sequences, so equal ids mean nothing.
- **Email alone does not work here.** A pass over all 87 emailless rows resolved **zero**.
  Two thirds are Composio rows whose metadata carries no address; most of the rest
  authenticate with an API key, which has no account holder to name. `backfill-account-email`
  is kept for the rows that *can* be resolved, but it is not the blocker it looked like.
- **A blank-on-blank "collision" is not a match.** An early version keyed unidentifiable
  rows as `type|`, so two rows sharing only a *type* collided: six of seven reported
  collisions were `(no email)` meeting `(no email)`. Unidentifiable rows are now ineligible
  and counted on their own line.
- **A zero needs a reason.** "No overlap" and "nothing was comparable" produce the same
  zero, and they are opposite instructions. The report breaks down *both* sides by how they
  can be identified, and says UNKNOWN rather than "it is a move" when nothing was comparable.
- **An unrecognised type is ambiguous, never defaulted.** Defaulting sends a client's Jira
  into the agent database, or an internal `staff-management` service into the tenant
  credential store — and neither throws. The type map in `IntegrationsClassify` is a
  judgement, stated in one place so it can be argued with.

### What the numbers actually say

The two tables hold **largely disjoint populations**, so this is a move rather than a merge —
for that reason, not because nothing was measured:

- iris_db is 92 rows of Composio-backed user integrations.
- fl_api is 30 rows dominated by **16 `social-*` rows with no credentials JSON at all**
  (instagram, tiktok, x, linkedin, threads). Those are brand-scoped accounts resolving
  through `Marketing\SocialAccountResolver` — the dormant brand tier. They never had an
  iris counterpart and are not part of this.
- Exactly **one** genuine duplicate: `google-drive iris#90 ↔ fl_api#11`.

### Order of operations

    1. rule on the ambiguous types            (vapi · macos · google-gemini are genuinely on the line)
    2. decide the winner for the one real pair (google-drive iris#90 / fl_api#11)
    3. move BUSINESS rows only, no dual writes
    4. point the creator path at fl_api for credentials
    5. drop the iris copy once nothing reads it

As of 2026-09-12 **nothing has moved**. Steps 1–2 are open. The account_email backfill that
used to sit at step 2 was measured and removed: it resolves nothing on this data.

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

**Run it instead of reading it:** `iris playbook run iris-integrations` — the sharing flow
above is a first-class section of that playbook, alongside connecting, executing and
self-debugging. That is the one an agent or a client on the standalone CLI should reach for.

Epic: `/p/epic-integration-tenancy` · #183590 #183591 #183592 #183593 ·
`iris how-to view iris-integrations`
