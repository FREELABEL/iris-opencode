---
name: hive-secure-mesh
description: Bring a machine onto the secure mesh (Tailscale) and make it a Hive node — onboard, lock down with a least-privilege ACL, connect, enroll, and diagnose. Use when a machine that is NOT on your network needs to be reachable (remote desktop, a GUI-only app like QuickBooks, a localhost-only database) or needs to run Hive tasks. Pass an action as argument (onboard, status, lockdown, connect, enroll, doctor, explain).
allowed-tools:
  - Read
  - Bash
  - Grep
---

# Hive Secure Mesh — Tailscale as the road, Hive as the work

Brings a machine anywhere in the world onto an encrypted mesh **without opening a single
port to the internet**, restricts who may reach it, and optionally makes it a Hive node so
IRIS can dispatch work to it.

## The model, in three layers

```
  Layer 3   IRIS Hive node        what IRIS may DO there — enroll, run, audit
  Layer 2   Tailscale ACL         WHO may reach it, and on which port
  Layer 1   Tailscale (WireGuard) the encrypted road — no public ports
```

Each layer is a separate decision, and diagnosing from the bottom up is what makes failures
obvious. Being on the mesh does not grant access — the ACL does. Being reachable does not
make a machine a Hive node — enrolling does.

## Two rails, and picking the right one

**This playbook is the tailnet rail.** There is a second, independent rail: the daemon,
where the machine dials *out* to IRIS over Pusher and executes `NodeTask`s. It needs no
Tailscale and no open ports.

- Need IRIS to **run something** on a machine? → daemon rail (`iris daemon start`)
- Need a human or session to **reach the machine itself** — RDP, a GUI app, a
  localhost-only port? → tailnet rail (this playbook)
- Both? They compose and do not conflict.

The trap: **a node reachable over Tailscale does not mean its daemon is running**, and a
running daemon does not mean the machine is on the tailnet. Independent rails, independent
failures.

## Quick Reference

```bash
iris hive vpn check                    # preflight THIS machine
iris hive vpn install                  # install Tailscale (auto-detects OS)
iris hive vpn up                       # join the tailnet (prints a login URL first run)
iris hive vpn status                   # every machine: name, OS, tailnet IP, online
iris hive vpn grant <group> <tag>      # scaffold a least-privilege ACL
iris hive vpn host <name>              # connection details for one host
iris hive vpn connect <name>           # launch remote desktop in one command
iris hive vpn enroll <tailnet-ip>      # register it as a Hive node over the tunnel
iris hive vpn doctor                   # health-check the whole chain
```

## Executable Steps (v2)

### step:explain What this is and which rail you want

```yaml
mode: shell
if: ${{args.action}} == explain
```

```bash
cat <<'TXT'
Tailscale is the road. The Hive is the work that travels on it.

  Layer 1  Tailscale   encrypted mesh, stable 100.x address, no public ports
  Layer 2  ACL         which GROUP may reach which TAG, on which PORT
  Layer 3  Hive node   what IRIS may do there once it can reach it

TWO RAILS — pick deliberately:

  daemon rail   machine dials OUT to IRIS. No Tailscale needed. Carries NodeTasks
                (sandboxed, audited). Set up with: iris daemon start
                Docs: iris how-to hive-dispatch

  tailnet rail  you dial IN to the machine. Needs Tailscale. Carries anything —
                RDP, SSH, a GUI app, a localhost-only database.
                Set up with: iris hive vpn up   (this playbook)

Use the tailnet rail when the thing you need has no API and someone has to be at
the keyboard. QuickBooks Desktop is the canonical case.

Both rails can run on the same machine. They do not conflict, and they fail
independently — which is the single most common source of confusion here.
TXT
```

### step:status What is on the mesh right now

```yaml
mode: shell
if: ${{args.action}} == status
```

```bash
echo "=== This machine ==="
iris hive vpn check 2>/dev/null || echo "hive vpn check unavailable — is the CLI current? (iris upgrade)"

echo ""
echo "=== The mesh ==="
iris hive vpn status 2>/dev/null || echo "Not on a tailnet yet — run: iris playbook run hive-secure-mesh onboard"

echo ""
echo "=== Hive nodes (layer 3 — separate from the mesh above) ==="
iris hive nodes list 2>/dev/null || echo "No nodes, or not authenticated"

echo ""
echo "NOTE: a machine can appear on the mesh and NOT be a Hive node, and vice versa."
echo "      Compare the two lists — the difference is usually the answer."
```

### step:onboard Bring THIS machine onto the mesh

```yaml
mode: shell
if: ${{args.action}} == onboard
```

```bash
set -e
echo "=== 1. Preflight ==="
iris hive vpn check || true

echo ""
echo "=== 2. Install (skips if already present) ==="
iris hive vpn install

echo ""
echo "=== 3. Join the tailnet ==="
echo "First run prints a login URL — open it and sign in."
iris hive vpn up

echo ""
echo "=== 4. Confirm ==="
iris hive vpn status

cat <<'TXT'

DONE — but this machine is not yet SECURED. A default tailnet lets every device
reach every other device, which is fine for one person and wrong the moment a
client machine or a contractor joins.

Next:  iris playbook run hive-secure-mesh lockdown --group <group> --tag <node-tag>
TXT
```

### step:lockdown Least-privilege ACL before anyone uses it

```yaml
mode: shell
if: ${{args.action}} == lockdown
```

```bash
GROUP="${{args.group}}"
TAG="${{args.tag}}"
if [ -z "$GROUP" ] || [ -z "$TAG" ]; then
  echo "Usage: iris playbook run hive-secure-mesh lockdown --group <group> --tag <node-tag>"
  echo ""
  echo "  group  the team allowed to connect, e.g. accounting"
  echo "  tag    the tag on the target machine, e.g. tag:qb-host"
  echo ""
  echo "Use a GROUP, never a list of people. Removing someone from the team then"
  echo "removes their access everywhere at once; an ACL listing individuals is a"
  echo "list you will forget to update, and forgotten access is still access."
  exit 1
fi

iris hive vpn grant "$GROUP" "$TAG"

cat <<'TXT'

This SCAFFOLDS the rule and prints it. A human still reviews and applies it in the
Tailscale admin console — deliberately. An ACL is a security boundary and should not
be edited by a machine on your behalf.

After applying, verify from a machine OUTSIDE the group: the host should be
invisible, not merely refused.
TXT
```

### step:connect Reach a host on the mesh

```yaml
mode: shell
if: ${{args.action}} == connect
```

```bash
HOST="${{args.host}}"
if [ -z "$HOST" ]; then
  echo "Usage: iris playbook run hive-secure-mesh connect --host <name>"
  echo ""
  echo "Machines on the mesh:"
  iris hive vpn status 2>/dev/null || true
  exit 1
fi

echo "=== Connection details ==="
iris hive vpn host "$HOST"

echo ""
echo "=== Launching session ==="
iris hive vpn connect "$HOST"
```

### step:enroll Make a mesh machine a Hive node

```yaml
mode: shell
if: ${{args.action}} == enroll
```

```bash
IP="${{args.ip}}"
if [ -z "$IP" ]; then
  echo "Usage: iris playbook run hive-secure-mesh enroll --ip <tailnet-ip>"
  echo ""
  echo "Tailnet IPs (the 100.x column):"
  iris hive vpn status 2>/dev/null || true
  exit 1
fi

echo "Enrolling $IP as a Hive node over the encrypted tunnel..."
iris hive vpn enroll "$IP"

echo ""
echo "=== Nodes now registered ==="
iris hive nodes list 2>/dev/null || true

cat <<'TXT'

Enrollment travels over the tunnel, so it never crosses the public internet.

REMEMBER: enrolled is not the same as executing. If tasks never run, the daemon on
that machine is the thing to check, not the mesh — different rail.
  iris how-to hive-dispatch
TXT
```

### step:doctor Diagnose, from the bottom layer up

```yaml
mode: shell
if: ${{args.action}} == doctor
```

```bash
echo "=== Layer 1+2: the road and who may use it ==="
iris hive vpn doctor 2>/dev/null || echo "hive vpn doctor unavailable — run: iris upgrade"

echo ""
echo "=== Layer 3: Hive nodes ==="
iris hive nodes list 2>/dev/null || echo "No nodes, or not authenticated"

echo ""
echo "=== Other rail: is the local daemon even running? ==="
iris daemon status 2>/dev/null || echo "Daemon not running on THIS machine"

cat <<'TXT'

READ IT BOTTOM-UP. The first broken layer is the only one worth fixing; everything
above it will look broken too and fixing those is wasted work.

  tailscale-not-installed          layer 1   iris hive vpn install
  machine missing from status      layer 1   powered on? logged in? run `up` there
  visible but connection times out layer 2   ACL — the road exists, you are not on it
  reachable but not in nodes list  layer 3   iris hive vpn enroll <ip>
  enrolled but tasks never run     daemon    different rail entirely — hive-dispatch

The last one wastes the most time. A perfect tailnet and a stopped daemon look
identical from the platform: the node is there and nothing happens.
TXT
```

## What this does not cover

- **The Tailscale admin console.** Users, DNS, auth keys and the authoritative ACL file
  live there. `grant` scaffolds; a human applies.
- **Auditing a human's RDP session.** Hive audits *Hive tasks*. Once you are at a remote
  desktop, you are at a desktop.
- **The daemon rail.** See `iris how-to hive-dispatch`.

## Why this combination is worth the setup

It collapses a normally-expensive problem — *give one group access to one application on
one machine, from anywhere, without exposing it to the internet* — into a handful of
commands, with the access rule written down as configuration instead of living in someone's
memory.

The usual alternatives are a VPN concentrator, a jump host, or port-forwarding and hope.
All three take longer to set up, are harder to revoke, and are much harder to explain to an
auditor than "this group, this tag, this port."
