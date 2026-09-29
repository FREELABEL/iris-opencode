---
category: Getting Started
level: beginner
tags: [buzz, agents, team, chat, acp, install, community]
duration_min: 5
---
# How to: Use IRIS in Buzz (`iris buzz setup`)

## What this does
[Buzz](https://github.com/block/buzz) is a team workspace from Block where people and AI agents
share channels. This puts IRIS in it as an agent your team can @mention. IRIS answers from your
company brain (Atlas), your integrations and your playbooks, and replies in the channel.

One command does all of it:
- installs the Buzz desktop app
- registers IRIS as an agent type
- joins your team's community

## Prerequisites
- A Mac. `--install` is macOS-only for now. On Windows or Linux, install Buzz yourself from
  its releases page, then run the same command without `--install`.
- The **invite link** for your team's Buzz community, from whoever runs it. It looks like
  `https://<community-host>/invite/<code>`.
- An IRIS account.

## Steps

### 1. Install IRIS and sign in
```bash
curl -fsSL https://heyiris.io/install-code | bash
iris auth login
```

### 2. Set up Buzz, in one line
```bash
iris buzz setup --install --community https://<community-host>/invite/<code>
```

What happens:
1. **Downloads Buzz** for your Mac's CPU from Block's GitHub releases. It **installs nothing
   unless the app is signed by Block, Inc. and notarized by Apple.** If Buzz is already
   installed and signed, the download is skipped.
2. **Registers IRIS** as an agent type in Buzz. The full path to `iris` is written in, because
   apps opened from the Dock can't see your terminal's PATH.
3. **Checks you're signed in to IRIS**, so the agent doesn't fail silently later.
4. **Opens Buzz on the invite**, and you're in your team's workspace.

### 3. Create your IRIS agent
In Buzz: **Agents → New agent**. Choose **IRIS** as the harness and give it instructions. Then
@mention it in any channel.

**Tip:** keep the instructions short and name where to look. For example: "For overview
questions, read Atlas item #<id> first. Use at most 3 lookups per answer." An agent with no such
rule can open records one by one and take dozens of steps for a simple answer.

## Options
| Flag | What it does |
|---|---|
| `--install` | Download and install Buzz first (macOS; signature-verified) |
| `--reinstall` | With `--install`: replace an existing Buzz |
| `--community <link>` | Join this community after setup |
| `--dry-run` | Show what would happen and change nothing |
| `--iris-path <path>` | Use a specific `iris` binary |

Related commands: `iris buzz status` checks the setup still works, and `iris buzz remove` takes
IRIS out of Buzz.

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| IRIS isn't in the agent list | Buzz reads agent types at launch | Quit and reopen Buzz |
| The agent reacts 👀, then goes quiet | It can't sign in to IRIS | Run `iris auth login`, then stop and start the agent in Buzz |
| "Not a Buzz invite link" | You pasted a channel or home URL | Ask for the `…/invite/<code>` link |
| Edited instructions do nothing | Buzz loads instructions when the agent starts | Stop and start the agent after every edit |
| Two agents with the same name | Editing can create a copy | Edit from the agent's own DM, and delete the copy |
| A second message restarts the task | Older IRIS CLI | `iris update` (v1.3.296+ continues the task instead) |

## Privacy
Buzz messages are **not end-to-end encrypted**. Whoever runs the Buzz server can read every
channel and DM, and every member can read every open channel, agents included. Keep health data
and other regulated data out of Buzz. Use private channels to keep an agent out of a conversation.

## Related
- `iris acp`: the Agent Client Protocol server Buzz talks to
- `iris find buzz`
