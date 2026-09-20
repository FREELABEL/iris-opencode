---
category: Infrastructure
level: intermediate
tags: [kinetic, kinetics, couple, camera, obs, devices, agents, safety, offline, ptz, robotics]
duration_min: 10
---
# How to: Decide which agent may move which body

## What this does

IRIS can already drive things in the physical world — a PTZ camera over USB, OBS, a phone, a TV,
a rented Windows machine. Until now, anything that could reach those commands could use them.

**Kinetic is the clutch between an agent and a body.** A body only moves for an agent that holds
a **couple**: a record on that machine saying *this exact agent, on this node, may use these verbs
on this body, on these terms*. No couple, no move.

## The four things a couple binds

| | | |
|---|---|---|
| **agent** | a sealed hash of the agent's definition | edit the agent and the hash changes, so the couple stops matching |
| **node** | the machine holding the body | a couple does not travel to another machine |
| **body** | `camera:obsbot-tiny`, `obs:studio` | `camera:*` covers every camera on that node |
| **verbs** | `move`, `record`, `zoom` … | anything not listed is refused |

Plus the terms: a ceiling on what one act may cost, a human confirmation on every act, and an
expiry date.

## Do it

```bash
# 1. Seal the agent. This is its identity — edit the agent later and this changes.
iris kinetic seal --agent "patrol"

# 2. Couple that hash to a body on this machine.
iris kinetic couple add \
  --agent sha256:95ab28… \
  --body camera:obsbot-tiny \
  --allow move,preset \
  --label patrol \
  --max-cents 50

# 3. Ask before you trust it. Nothing is touched by a check.
iris kinetic check camera:obsbot-tiny move     # ALLOW   (exit 0)
iris kinetic check camera:obsbot-tiny record   # REFUSE  (exit 5)

# 4. See what is coupled here, and what has happened.
iris kinetic couple list
iris kinetic log

# 5. End it. This takes effect on the next act, not the next login.
iris kinetic couple revoke cpl_mu9buyovdiqt
```

An agent identifies itself by setting `IRIS_AGENT` to its sealed hash (and `IRIS_RUN_ID`, if the
run should be traceable) before it calls `iris camera` or `iris obs`.

## You, at your own keyboard

An operator at a terminal is **not** an agent act. Your own `iris camera left` keeps working, and
is recorded as *unbound* — never booked to an agent that did not do it.

If a machine should be strict about that too — a studio, a client's office, anything unattended:

```bash
iris kinetic lock        # now EVERY act here needs a couple, including yours
iris kinetic lock --off
```

## Why it lives on the machine, not in the cloud

The couples file (`~/.iris/kinetic/couples.json`) sits on the node that holds the body, so the
guard still works with the network down — which is exactly when an unattended body is most likely
to be moving. A cloud copy would be a report, not permission.

The consequences of that are worth knowing:

- **A file that will not parse authorises nothing.** Corrupt it and every agent act is refused.
- **Couples are per machine.** The same agent on two nodes needs a couple on each.
- **Revoking is local too.** Revoke on the node that holds the body.

## What it does NOT do yet

- Acts are recorded to `~/.iris/kinetic/acts.jsonl` on the node. Booking them to the Mint ledger
  as `expense:device:*` is the next step.
- Reads are open. `iris camera list` and `iris camera pos` are not acts — looking is not moving.
- The sealed hash is derived from the agent's definition. When Mint issues identities, a couple
  will carry that hash instead, and nothing about the record changes.

Related: `iris kinetic --help` · the Kinetics epic (#184906) · `iris hive` for reaching a node.
