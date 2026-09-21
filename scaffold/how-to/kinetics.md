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

## Every act path, not the ones someone remembered

The check runs once, before any command, from a table of what counts as an act
(`iris kinetic bodies` lists the classes and their verbs). So `iris hive run`, `iris device clean
--apply` and `iris n8n trigger` are covered without anyone wiring them, and a new act path is
covered by adding a row.

Reads are not acts: `iris camera list`, `iris obs status`, `iris hive nodes` and a `device clean`
dry run all pass untouched.

## A fleet: issue in one place, verify on every node

A couple still lives on the machine that holds the body — that is what makes it work offline. To
avoid typing one on every node, ISSUE it centrally and let each node verify the signature locally,
with no call to anyone:

```bash
# once, on the machine that will issue (keep the private key there)
iris kinetic issuer new                      # prints iss_… and writes issuer.key(.pub)

# on every node that should accept its couples — the PUBLIC key only
iris kinetic issuer trust --file issuer.key.pub
iris kinetic issuer list

# issue for a node, sign it, hand it over
iris kinetic couple add --agent sha256:… --body camera:* --allow move --node laptop --sign
iris kinetic couple export > fleet.json

# on that node
iris kinetic couple import fleet.json
```

Every field that grants anything is signed — the agent, the node, the body, the verbs, the
budgets, the expiry. Change one and the signature stops verifying. The label is not signed, since
renaming it grants nothing.

**Three ways to take it away**, in increasing size: `couple revoke` ends one couple on one node and
that no survives a re-import; `issuer untrust` drops everything an issuer ever signed on that node;
and a short `--expires` means an unreachable node forgets by itself.

## Budgets that see a whole night, not one act

A per-act ceiling never fires on a thousand cheap acts, which is the shape runaway automation
usually has. So a couple can carry windows:

```bash
iris kinetic couple add --agent sha256:… --body node:* --allow run \
  --max-cents 100 --max-day-cents 1500 --max-day-acts 200
iris kinetic spend cpl_…      # this run, today, acts today, against each ceiling
```

An act declares its own cost — `IRIS_ACT_CENTS=60` (which works for any command), or `--cents` on
commands that define the flag. **Nothing guesses a cost**, so an act that declares nothing counts
as zero; the ceilings exist for the acts that do declare, like rented compute and metered APIs.
Only allowed acts count against a budget — being refused all day cannot exhaust it.

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
- **Couples are per machine.** The same agent on two nodes needs a couple on each — issue and
  import them rather than typing each one (above).
- **Revoking is local too.** Revoke on the node that holds the body, or untrust the issuer.

## What it does NOT do yet

- Acts are recorded to `~/.iris/kinetic/acts.jsonl` on the node. Booking them to the Mint ledger
  as `expense:device:*` is the next step.
- The sealed hash is derived from the agent's definition. When Mint issues identities, a couple
  will carry that hash instead, and nothing about the record changes.
- A couple is checked precisely when the command names its target (`hive run <node>`). When the
  command picks its device inside the handler (a camera), the first check is class-level and the
  act path checks the instance — so a couple for one camera does not become a couple for all of
  them, but the refusal for the wrong camera arrives a moment later.
- Costs are declared, never measured. A budget is only as honest as what the caller reports.

Related: `iris kinetic --help` · the Kinetics epic (#184906) · `iris hive` for reaching a node.
