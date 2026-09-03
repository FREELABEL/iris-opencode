---
category: CRM & Sales
level: intermediate
tags: [crm, email, messaging, integration]
duration_min: 12
---
# How to: send and log communications (the Comms Router / reachr)

Every outbound message — iMessage, Apple Mail, platform email, SMS, Instagram DM, LinkedIn —
should go out through ONE path so it lands in `lead_comms` with the outreach attribution that
says which strategy, step and script produced it.

Before this existed, `iris imessage send` shelled out to AppleScript and `iris mail send` posted
straight to the bridge. Both worked; neither recorded anything. The comms log was only ever as
fresh as the last time somebody remembered to run an ingest sweep.

## Send

```bash
# To a CRM lead — gets full attribution and authorization
iris imessage send 4821 "running late, be there at 3"
iris mail send them@example.com --subject "Following up" --body "..."

# As a registered identity — verified, routed on ITS channel order, logged against it
iris mail send them@example.com --sender alex-mayo-iris --subject "..." --body "..."

# See which channel would be used, and why, without sending
# (imessage → apple_mail → email → sms, first one that canSend())
```

`--sender` names an identity from `iris senders`. An unverified or archived one is REFUSED rather
than quietly downgraded to the fallback signature — naming a sender asserts the message comes from
it. It needs a lead (or a handle that resolves to one): the genuinely ad-hoc handle path bypasses
the channel bindings, so a sender there would be signed by one identity and delivered from
another. Do not combine it with `--from`, which is an unchecked address on the unrouted path.

Messages are delivered **VERBATIM**. The channel drivers otherwise treat text as an *AI prompt*,
so without this a message like "running late, be there at 3" would be handed to a model and
something else entirely would go out.

Confirm it was recorded — "sent" and "sent AND on the record" are different states:

```bash
iris atlas:comms list <lead>        # the unified log for one lead
iris atlas:comms summary <lead>     # channel breakdown
```

If the CLI prints `NOT LOGGED`, the message went out and the ledger does not know. That is a real
gap, not cosmetic — say so rather than assuming it was fine.

## Email signatures

Resolution order, first hit wins: **explicit → strategy sender identity → agent identity → your
default preset → configured preset → none**.

```bash
# what's available and what the policy is
docker exec fl-api php artisan comms:signatures
docker exec fl-api php artisan comms:signatures --check       # exercise every path
docker exec fl-api php artisan comms:signatures --preset=iris  # render one
```

When nothing resolves, `OUTREACH_SIGNATURE_ON_MISSING` decides:
`warn` (default — sends unsigned but warns and logs), `block` (refuses the send),
`allow` (silent — transactional mail only). iMessage and SMS never get a signature block.

## Sending AS someone else (on behalf of)

SHIPPED TODAY. The identity a message signs as lives on the outreach STRATEGY, as six override
fields. Create a strategy whose sender is that person and every message through it signs as them.

```bash
cat > son-college-outreach.json <<'JSON'
{
  "name": "College outreach — on behalf of <name>",
  "category": "cold_outreach",
  "sender_name_override": "Jordan Mayo",
  "sender_role_override": "Prospective Student",
  "sender_email_override": "jordan@example.com",
  "sender_phone_override": "+15125551234",
  "sender_calendar_override": "https://cal.example.com/jordan"
}
JSON

iris outreach create <bloq-id> --from-json son-college-outreach.json
iris outreach show <bloq-id> <strategy-id>
```

All six are optional except that `sender_name_override` is effectively required — the strategy
email path HARD-FAILS without it ("update the template with a sender name before sending"),
which is deliberate. `sender_email_override` is validated as an email and
`sender_calendar_override` as a URL.

TWO THINGS THIS DOES NOT DO YET, and both matter before a real run:

1. **It does not change who the mail is FROM.** These fields set the SIGNATURE. Delivery still
   uses the platform mailbox (Resend) or whatever Mail.app account the bridge picks. A message
   signed by one person and delivered from another address reads as spoofing to a recipient.
   If the From header matters, send through Apple Mail with an explicit `--from` for now, and
   check the RECEIVED message rather than the send response.
2. **Nothing verifies the identity is yours to use.** Any name and any address typed into a
   strategy will be signed faithfully. Treat it as you would a letterhead: fine for someone who
   asked you to write for them, not something to point at an identity that has not.

## Senders — the verified identity (preferred over strategy overrides)

SHIPPED. A Sender is the identity above promoted to a row WITH A GATE: unverified means
draft-only. It fixes both problems in the section above — it binds a transport, and nothing can
sign as an identity that has not been established as yours.

```bash
iris senders list                       # ✓ can send · ○ draft only
iris senders create --name "Jordan Mayo" --email jordan@example.com --role "Prospective Student"
iris senders verify jordan-mayo         # REQUIRED — created unverified, always
iris senders bind jordan-mayo --channel apple_mail --value jordan@icloud.com
iris senders bind jordan-mayo --channel email --value jordan@heyiris.io --primary
iris senders prefer jordan-mayo --order email,apple_mail   # which provider it reaches for FIRST
iris senders show jordan-mayo           # prints the rank: (primary), (2), …
iris senders default jordan-mayo        # which IDENTITY is default — a different question
```

Then point a strategy at it — the sender wins over the six `sender_*_override` columns:

```bash
iris outreach update <bloq> <strategy-id> --from-json '{"sender_id": 12}'
```

**Verification methods:** `resend_domain` (the domain is our Resend sending domain),
`local_mailbox` (Mail.app on this machine), `delegated` (a human authorised it — records who
and why). `php artisan senders:verify --all` RE-CHECKS and revokes anything that lapsed, because
a check that can only go false→true is not a check.

**Delegated senders are VERBATIM-ONLY by default.** Signing as a real person who asked you to
write for them is ordinary; implying they wrote it when a model did is not. A generated send
under a delegated identity is refused unless `metadata.allow_generated` is set deliberately.

**A sender with no binding for the channel REFUSES rather than falling back** to the default
mailbox — a message signed by one identity and delivered from another reads as spoofing.

**Each sender picks its own provider order.** `outreach.channel_preference` is platform-wide, and
the platform cannot know that one identity is a personal mailbox that should leave via Apple Mail
while another is a company address that must always leave via Resend. With no explicit order a
sender uses the channels it is BOUND to, ranked by the global list — so a sender bound only to
`email` is never routed onto `apple_mail` and then refused for a missing binding. An explicit
`--channel` on a send still outranks everything; a preference is an order, not a mandate, so an
unreachable first choice falls through to the second.

`prefer` REJECTS a channel with no binding rather than accepting it: that setting would queue a
send the router refuses at delivery time — a configuration mistake shaped like an outage.

**Campaigns are the one place the preference does NOT apply**, and deliberately: a campaign step
declares its own channel, and that is the step author's instruction, not something a sender
preference may quietly override. Which means a mismatch there fails at DELIVERY — one refused step
at a time, hours after launch. Ask before the send instead:

```bash
docker exec fl-api php artisan senders:check-bindings          # or: railway ssh -s fl-api -- …
docker exec fl-api php artisan senders:check-bindings --json   # exits non-zero if anything would fail
```

It covers both halves — strategies not yet run, and pending steps already queued that will fail on
the next tick — plus apple_mail bindings pointing at accounts Mail.app no longer has. It reports
how many channel assertions it actually made, so an all-clear over nothing cannot look like an
all-clear over everything.

**Apple Mail bindings are checkable now.** See what this Mac can send from:

```bash
iris mail accounts
iris senders bind <slug> --channel apple_mail --value <one of those addresses>
```

Binding an address Mail.app lacks is refused, and so is SENDING from one — the bridge resolves the
account before composing and returns a 422 listing the addresses that work. (`force=true` exists
for configuring a machine other than the one that will send.)

This used to be documented as "an unknown account sends from the default, silently". It never did
that: the bridge's lookup threw `-1700` and **every** Apple Mail send naming a from-address failed
outright — the binding path had never worked. Fixed in `iris-daemon` 25ba0fd.

Still true, and still the reason to check a received message: the bridge guarantees the account
EXISTS; Mail.app applying it is a separate claim that only the received header settles.

Existing strategies that predate senders can be promoted in place — dry run first, and note that
what it creates is UNVERIFIED, because moving free text into a row does not make it trustworthy:

```bash
php artisan senders:backfill            # DRY RUN
php artisan senders:backfill --apply
```

## Verify it end to end

```bash
# bookkeeping only — fake driver, safe anywhere
docker exec fl-api php artisan comms:verify-router

# a REAL message. --to has no default on purpose. Use your OWN handle.
docker exec fl-api php artisan comms:send-real --to=me@example.com --channel=apple_mail
```

## Gotchas

- **Do not start the iMessage bridge provider** to test sending. It blasts auto-replies to real
  contacts (#137256). iMessage sending is fixed but unproven for this reason.
- The bridge needs `BRIDGE_URL` and `BRIDGE_AUTH_KEY` in the container. Without `BRIDGE_URL`,
  `isBridgeOnline()` falls through to a node registry that does not answer locally.
- A **cold** Mail.app takes >20s to become scriptable. Warm sends take ~8s.
- `iris mail send --attachment/--cc/--from` has no router path yet — it falls back to the direct
  bridge call and tells you it is not logged.
- Ingest (`iris atlas:comms ingest`) is a REPAIR tool for messages sent outside IRIS (from your
  phone, or by hand in Mail.app). It is not how outbound traffic is supposed to reach the log.

## Still bypassing the router

These send without logging. Know them before trusting the log as complete:
`iris run send_email` / `send_imessage` (routed now, falls back on failure), the V6 agent macOS
integration, `iris pulse --notify`, and anything calling the bridge on `localhost:3200` directly.
