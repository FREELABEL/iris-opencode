# SPEC — IRIS Agent Messaging (unified, attributed, logged, verified send)

**Status:** proposed · **ROOT CAUSE:** #150044 (agent discoverability — agents bypass existing verbs for raw tooling) · **Filed gaps:** #150042 (messaging) · #150043 (drive/sheets read) · **Origin:** PM/orchestrator agent had to hand-roll `sqlite3 chat.db` + `osascript` to send one group iMessage as "@IRIS" (2026-06-23).

> **Framing:** #150044 is the parent — discoverability is *why* the agent never reached `iris imessage send-group`. Fixing it (intent→command routing + a machine-readable capability manifest) makes the messaging feature-gaps below cheaper, because the right verb gets used in the first place. This spec is the "graceful" target *behind* a discoverable surface.

---

## Problem
The CLI already has the *pieces* to message people — `iris imessage send|send-group|groups`, `iris slack`, `iris mail`, `iris whatsapp`, lead-ID handle resolution, and `atlas:comms` (a unified comms **log**). Yet an agent doing a routine PM task (text a decision-request to a client **group chat**, signed as the agent) bypassed all of it and dropped to raw `sqlite3`/`osascript`. The pieces don't compose into one graceful, agent-discoverable, *safe* action. Six concrete gaps:

1. **Discoverability / routing** — no `iris leads message <id>` to message a lead (or their group) from the leads workflow; the send verbs aren't surfaced at the point of need, so agents reach for raw tooling.
2. **Unnamed-group resolution** — `send-group <query>` keys off name/participant, but a group with **no display_name** must be resolved by its **participant set** (e.g. David **and** Robyn), with **disambiguation** when several chats share a participant. Today that means a manual `chat.db` join.
3. **Attribution** — no `--as/--sign` for an agent signature; "— @IRIS" was hand-appended. No convention for "an agent sent this, not the human."
4. **Verification** — no delivery confirmation; required a re-query of `chat.db`.
5. **Outbound comms logging** — a send (esp. the raw path) is not written to `atlas:comms`/the lead's history; agent-sent messages vanish from the record.
6. **Multi-channel** — the recipient is reachable on iMessage / Slack (PATTY) / RingCentral / email; there is no "message this lead on the best channel" router (`atlas:comms` is the log, not a send).

## Vision — one verb, safe by default
```
iris message <to> "<text>" [--as <agent>] [--channel auto|imessage|slack|email|ringcentral]
                           [--group] [--dry-run] [--confirm] [--no-log]
# aliases / sugar:
iris leads message <leadId> "<text>" --as IRIS          # message a lead, auto channel
iris leads message <leadId> --group "<text>" --as IRIS  # message the lead's group chat
```
The system: **resolves** the recipient → **picks** the channel → **signs** as the agent → **sends** → **verifies** delivery → **logs** to `atlas:comms`. Outward send is **confirm-gated** for agents.

## 1. Resolution layer (the hard part — gap #2)
- `<to>` accepts: **lead ID**, contact name, raw handle (phone/email), or a **participant set** (`--with 28307,21622`).
- **Group resolution:** match by (a) explicit group name, (b) **exact participant-set** (the chat whose non-me handles == the resolved handles), (c) fuzzy participant. Unnamed groups resolve by (b).
- **Disambiguation:** if >1 candidate chat, return the ranked list (last-active first) and require `--chat <guid>` rather than guessing. Never silently pick.
- Reuse `resolveHandleToGuid` + the `chat_handle_join` query already in `drivers/native-imessage.js`; add a `resolveGroupByParticipants(handles[])`.

## 2. Attribution (gap #3)
- `--as <agent>` (default off; `IRIS` is the house convention) appends a signature line — `\n\n— @IRIS` — configurable per agent (`agent.signature`).
- Recorded on the `atlas:comms` entry as `sent_by_agent: <id>` so the human↔agent distinction is queryable.

## 3. Delivery + verification (gap #4)
- After send, poll the channel for the outbound receipt (chat.db `is_from_me` row / Slack ts / Mail id) with a short timeout; return `{ ok, channel, messageId, verifiedAt }`.
- Non-fatal if verify times out — report `delivered: unconfirmed`, never a silent success.

## 4. Auto-logging (gap #5)
- Every send writes an **outbound** `atlas:comms` row on each recipient lead (channel, text, agent, timestamp, messageId) — so the lead's history is complete regardless of channel or path.
- `--no-log` opt-out for noise.

## 5. Multi-channel router (gap #6)
- `--channel auto` picks from a per-lead **preference + presence** ladder: explicit pref → last-active channel → fallback (iMessage → SMS → email). RingCentral/Slack honored when the lead has those integrations (e.g. Robyn = RingCentral ext 101, PATTY Slack).
- Each channel is a driver implementing `send(recipient, text, opts) → receipt`; iMessage/Slack/Mail drivers already exist — wrap them behind the router.

## 6. Guardrails (agent safety)
- **Outward sends are confirm-gated**: agents must pass `--confirm` (or run `--dry-run` first, which renders the resolved recipient + final text + channel). The harness already treats outward actions as needing authorization — this makes it explicit + auditable.
- Per-board **allowlist** + rate-limit; refuse unknown handles unless `--force`.

## Build-on vs net-new
| Capability | Exists | Net-new (this spec) |
|---|---|---|
| iMessage send / send-group / groups | ✅ `iris imessage` | router wrapper |
| Slack / Mail / WhatsApp send-read | ✅ | router wrapper |
| Lead-ID → handle resolution | ✅ `send <leadId>` | extend to groups |
| **Group-by-participant-set resolution + disambiguation** | ❌ | **build** (gap #2) |
| **Agent attribution `--as`** | ❌ | **build** (gap #3) |
| **Delivery verification** | ❌ | **build** (gap #4) |
| **Outbound auto-log to `atlas:comms`** | ⚠️ partial | **wire** (gap #5) |
| **`auto` channel router** | ❌ | **build** (gap #6) |
| **`iris leads message <id>`** | ❌ | **build** (gap #1, the discoverability fix) |

## Why it's a product, not a one-off
This is the substrate for **every agent→human touch**: PM status/decision requests (this case), lead outreach, Wedge-K notifications, approval pings (Dr. Ron approve-by-link, RECORDS-1), heartbeat alerts. One attributed/logged/verified send path means agents communicate **on the record, in the user's voice-or-the-agent's**, across any channel — and it composes with the coding-agent-bridge that already runs the inbound side.

## Acceptance criteria
1. `iris leads message 28307 --group --with 28307,21622 "hi" --as IRIS --dry-run` renders the resolved **unnamed** group, channel, and signed text — no guessing.
2. With `--confirm`, it sends, returns a verified receipt, and an outbound `atlas:comms` row appears on **both** leads tagged `sent_by_agent`.
3. `--channel auto` routes Robyn via her preferred channel; falls back gracefully.
4. Ambiguous group → ranked candidate list + required `--chat`, never a silent wrong-chat send.
