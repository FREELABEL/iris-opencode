---
category: Getting Started
level: beginner
tags: [mcp, connectors, claude, chatgpt, grok, gemini, perplexity, mistral, cursor, vscode, claude-code, integration, ai-assistants]
duration_min: 5
---
# How to: Connect IRIS to ChatGPT, Claude, Grok, Gemini and other AI assistants

## What this does

Adds IRIS to the AI assistant you already use. Once it's connected, you can ask that assistant
to work with your IRIS leads, pages, agents, Atlas boards and the rest of the IRIS command line
(the same 1,300+ commands), and it acts **as you**, on your real data.

Every assistant connects to the same address:

```
https://heyiris.io/mcp
```

`https://heyiris.io/api/mcp` is the same server under its original address. Both work, and you
don't need to change a connection that already uses it.

## Before you start

- An IRIS account. You'll sign in to it once, in a browser window the assistant opens.
- The assistant connects from its own cloud, so nothing needs to be installed on your computer
  (apart from the developer tools at the end).
- **Writes are real.** Sends, publishes, invites and payouts happen immediately. Ask the assistant
  to show you what it's about to do before anything that can't be undone.

## What signing in looks like (every assistant)

1. You paste the URL. The assistant finds IRIS and registers itself automatically, so there's no
   client ID or secret to copy.
2. An IRIS window opens. Sign in if you aren't already, and you'll see which app is asking.
3. Click **Approve**. The window closes and the assistant lists the IRIS tools.

If an assistant asks you to choose an authentication method, pick **OAuth** or
**Register automatically / Dynamic client registration**. Don't pick "API key" or "No auth".

---

## Claude (claude.ai, Claude Desktop, Claude mobile)

**Pro, Max and Free** (Free allows one custom connector):

1. Go to **Customize → Connectors** (`claude.ai/customize/connectors`).
2. Click **+ Add → Add custom connector**.
3. Name: `IRIS`. URL: `https://heyiris.io/mcp`. Click **Continue**.
4. Keep the detected sign-in method and click **Add**, then sign in to IRIS and approve.
5. In a chat, click **+** (bottom left) **→ Connectors** and turn **IRIS** on.

**Team and Enterprise:** members can't add custom connectors themselves. An Owner adds it under
**Organization settings → Connectors → Add → Custom → Web** with the same URL, and then each member
clicks **Connect** under Customize → Connectors.

- **Desktop:** connectors you add on the web appear in Claude Desktop automatically.
- **Mobile:** you can use IRIS on mobile once it's added on the web or Desktop. Add it there first.

Source: support.claude.com, "Get started with custom connectors using remote MCP".

## ChatGPT

1. On **chatgpt.com** (web; mobile isn't supported), open **Plugins → +** and choose to add a
   custom MCP server.
2. Name: `IRIS`. Under **Connection**, enter `https://heyiris.io/mcp`.
3. Authentication: **OAuth**. Accept the warning and click **Create**, then sign in to IRIS and
   approve.
4. In a chat, type **@** and pick **IRIS**.

**Which plans can do this:**

| Plan | What you get |
|---|---|
| Business, Enterprise, Edu | Full access, including write actions. An admin or owner has to create and publish the plugin for the workspace (Admin Console → Plugins). |
| Pro | Read and fetch tools only. |
| Plus, Free, Go | OpenAI's documentation doesn't say they can add custom MCP servers. |

ChatGPT may ask you to confirm a write action before it runs. In a workspace, if new IRIS tools
don't show up, ask the admin to refresh the plugin.

Source: help.openai.com, "Developer mode, apps and full MCP connectors in ChatGPT".

## Grok

1. Go to **grok.com/connectors**.
2. Click **New Connector → Custom** and enter `https://heyiris.io/mcp`.
3. Sign in to IRIS and approve. Grok then lists the IRIS tools.

On a Grok Business or Enterprise workspace, an admin adds the connector first.

Source: docs.x.ai, "Grok connectors". Tested with IRIS on 2026-11-27.

## Gemini (gemini.google.com)

1. On the **web**, open **Settings → Connected Apps → Custom apps → Add a custom app**.
2. Enter `https://heyiris.io/mcp`, click **Next** and follow the prompts. Sign in to IRIS and
   approve.
3. Once it's added on the web, you can use it in the Gemini mobile app too.

Google currently requires a personal Google account (not work or school), age 18+, the US, English,
and Gemini history turned on.

Source: support.google.com/gemini, "Connected apps / custom apps".

## Perplexity

1. In the sidebar, open **Plugins → Add custom → Add MCP connector → Remote**.
2. Name: `IRIS`. URL: `https://heyiris.io/mcp`. Accept and click **Add**.
3. Click the IRIS card to sign in, then approve.

In an organization, an admin first has to turn on **Allow members to add custom connectors**
(it's off by default).

Source: perplexity.ai help center, "Adding custom remote connectors".

## Le Chat (Mistral)

1. Open **Connectors → + Add Connector → Custom MCP Connector**.
2. Name: `IRIS` (no spaces). URL: `https://heyiris.io/mcp`. Click **Connect**, then sign in to IRIS
   and approve.

On Free, Pro and Student accounts you're the admin, so you can add it yourself.

Source: docs.mistral.ai, "MCP connectors".

## Microsoft Copilot

Individual users can't add a custom MCP server today. Microsoft 365 admins can register IRIS as a
*custom federated connector* in the M365 admin center, and it's read-only there.

---

## For developers

### Claude Code

```bash
claude mcp add --transport http iris https://heyiris.io/mcp --scope user
```

Then run `/mcp` inside Claude Code, pick **iris**, and sign in. `--scope user` makes IRIS available
in every project. Leave it off to add it to the current project only.

If you use the IRIS command line, `iris mcp install` wires up Claude Code, Claude Desktop,
Cursor, Gemini CLI and opencode in one go.

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{ "mcpServers": { "iris": { "url": "https://heyiris.io/mcp" } } }
```

Cursor opens the IRIS sign-in the first time it uses the server.

### VS Code (GitHub Copilot)

Run **Chat: Open Customizations → MCP Servers → Add Server (+) → HTTP**, enter
`https://heyiris.io/mcp` and give it the ID `iris`. Or add this to `.vscode/mcp.json`:

```json
{ "servers": { "iris": { "type": "http", "url": "https://heyiris.io/mcp" } } }
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{ "mcpServers": { "iris": { "httpUrl": "https://heyiris.io/mcp" } } }
```

Use `httpUrl`, not `url` (`url` means the older SSE transport). Run `/mcp auth iris` to sign in.

### xAI API (Grok in your own code)

There's no browser sign-in here; you pass a token yourself:

```python
tools=[{"type": "mcp", "server_url": "https://heyiris.io/mcp",
        "server_label": "iris", "authorization": "<your IRIS API key>"}]
```

---

## Check it worked

Ask the assistant:

> Use IRIS to show me the help overview.

It should call the `iris_help` tool and answer from IRIS. If it says it can't find IRIS, turn the
connector on for that chat (Claude: **+ → Connectors**; ChatGPT: type **@IRIS**).

## Troubleshooting

| What you see | What to do |
|---|---|
| "Page Expired" or a 419 error | You're on an old address. Use `https://heyiris.io/mcp` exactly. |
| The sign-in window opens and closes with no tools listed | Remove the connector, add it again, and click **Approve** this time. |
| It worked, then asks you to sign in again | Sign in again. Disconnecting in IRIS, or a long idle period, ends the session. |
| ChatGPT: you can't find **Plugins** | Your plan may not include custom MCP (see the table above). |
| Team or work account: no "Add custom connector" option | Your admin has to add it (see each section above). |
| Opening the URL in a browser shows a setup page | That's expected. The page is for people; assistants talk to the same URL. |

## Disconnecting

Remove IRIS from the assistant's connector or plugin list. That stops the assistant from using
your IRIS account.

## Related

- `drive-iris-from-claude-code`: use Claude Code as the orchestrator for IRIS
- `hive-mcp`: let one of your own machines run an MCP server
