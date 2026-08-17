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

# See which channel would be used, and why, without sending
# (imessage → apple_mail → email → sms, first one that canSend())
```

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
iris senders show jordan-mayo
iris senders default jordan-mayo
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

STILL TRUE, and the reason to check a received message: if the bound Mail.app account does not
exist, the bridge leaves the sender unset and Mail.app sends from its default SILENTLY. Binding
makes the From header right when the account exists; it cannot prove it by itself.

Not yet built: SN-2 (backfilling existing strategy overrides into senders).

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
