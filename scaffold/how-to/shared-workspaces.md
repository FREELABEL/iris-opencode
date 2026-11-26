---
category: Agents & Automation
level: beginner
tags: [workspace, rooms, team, share, sessions, codex, claude-code, multiplayer, stop]
duration_min: 10
---
# How to: Share live AI chats with your team

## What this does

Your teammates see your AI chats as they happen, from their own computers, and can step in.
Someone working a deal with an agent goes the wrong way; you open the same chat, type the
correction, and if it is in the middle of the wrong thing, you stop it. No screen sharing.

- A **workspace** is one of your Atlas projects. Everyone in the project is on the team.
- A **room** is one live chat with an agent — on anyone's computer, in any folder.
- What you can do depends on your role in the project:

| Role | Can |
|---|---|
| viewer | watch every room as it happens |
| editor | + type into any room (your name is shown with what you type) |
| owner | + stop a room's agent |

Whoever opened a room can always stop it, and so can whoever sent the message it is working on.

## Before you start

```bash
iris login
iris hive connect        # lets your team reach the chats you share — nothing else on your computer
```

## 1 · Invite your team

Use a project you already have, or make one:

```bash
iris atlas create --name "pricing launch"            # prints the project id, e.g. 812
iris workspace invite 812 --email flo@company.com    # editor by default; --role viewer to only watch
```

Send them the link. Only the person it names can use it.

## 2 · Share a chat

Find the chat you want to share:

```bash
iris hive sessions
```

Then share it:

```bash
iris workspace open 812 --session <session-id> --name "pricing page"
```

Works with Claude Code (running inside tmux), IRIS Desktop, and Codex or Gemini started with
`iris acp run --keep --agent codex` (or `gemini`).

## 3 · See what your team is doing

```bash
iris workspace rooms 812          # every shared chat in the project
iris workspace watch <room-id>    # follow one as it happens (Ctrl-C to stop)
```

`watch` starts by telling you where the chat runs and whether that computer is on.

## 4 · Step in

```bash
iris workspace say <room-id> "start with the failing test in pricing.spec.ts"
iris workspace stop <room-id>     # owners, or whoever sent the message it is working on
```

## When something does not work

| You see | It means | Do |
|---|---|---|
| `No such room — or it is not shared with you.` | wrong id, or you are not in the project | `iris workspace rooms <project>` |
| `You can watch this room but not post in it.` | you are a viewer | ask the owner for editor |
| `saved · the computer is offline…` | that computer is asleep | nothing — it gets your message when it is back |
| `saved in the room · …this minute` | lots of people are typing into one chat | wait a minute; nothing was lost |
| `…not inside tmux…` | a Claude Code chat outside tmux cannot be reached | start Claude Code inside tmux |
| `The IRIS bridge on <computer> is out of date` | that computer needs an update to use Stop | run `iris bridge update` on it |

## Good to know

- Messages are limited to 16,000 characters.
- The room's own IRIS agents reply to the room's owner; your messages still reach the live chat.
- Sharing a chat shares that chat only — not your files, not your other chats.
- Every command takes `--json`, so a script or another agent can do all of this too.
