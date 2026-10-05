---
category: Agents
level: intermediate
tags: [agents, approvals, trust, autonomy, intern, specialist, lead, hitl, human-in-the-loop, safety, rate-limit, slack, email]
duration_min: 8
---
# How to: Decide what an agent may do without asking you

## What this does

Every tool an agent can use declares what kind of action it is — reading, writing to its own
space, writing to something shared, sending something out, or spending money. An agent's
**trust level** decides which of those it does on its own and which it holds for you.

| Trust level | Runs on its own | Waits for your approval |
|---|---|---|
| `intern` | reads | everything else |
| `specialist` | reads, its own notes and boards | shared writes, anything sent out, payments |
| `lead` | everything except payments | payments |
| *(none set)* | everything, in chat — same as before | — |

Phone calls are stricter: an agent with no level set behaves as `specialist` on a call, because
the person directing it is whoever dialled.

## Steps

**1. Set the level**

```bash
iris agents update 42 --autonomy specialist
iris agents get 42          # shows: Autonomy: specialist — what it holds and why
```

`--autonomy none` removes the level (back to the old behaviour).

**2. When something is held, you are told**

You get a message — Slack DM if you connected Slack, otherwise email — naming the agent, the
tool and what kind of action it is. It never contains the details. The link opens a confirm page;
nothing is approved by opening it.

**3. Review and decide**

```bash
iris schedule approvals list
iris schedule approvals approve 812
iris schedule approvals approve 812 --args '{"subject":"Corrected subject"}'   # approve your edit
iris schedule approvals reject 812 --notes "Not to this client"
```

An edited approval is checked again before it runs. It cannot change which action runs, point at
records the agent never asked about, or send to a different destination.

**4. A "no" is remembered**

Rejected actions and their reasons are shown to the agent on its next runs, and the same action
is not queued again for 7 days.

## Volume caps

Agents with a trust level also have per-hour and per-day caps on sends (30/200), payments
(3/10), shared overwrites and shared writes. Hitting one pauses the agent and tells you. Raise a
cap in the agent's config: `config.rate_caps.egress.per_day`. Resume with
`iris agents resume <id>`.
