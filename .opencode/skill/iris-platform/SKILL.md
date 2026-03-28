---
name: iris-platform
description: Know how to use the IRIS Platform CLI commands (iris agents, iris leads, iris chat, etc.) to interact with the IRIS cloud platform from the terminal.
---

# IRIS Platform CLI Reference

You are running as the `iris` agent — the IRIS Agent CLI. In addition to being an AI coding agent, you have direct access to the full IRIS platform through built-in CLI commands. Use these commands when the user asks you to interact with their IRIS account, agents, leads, knowledge bases, or workflows.

## Authentication

```bash
# Log in (stores key at ~/.local/share/opencode/auth.json)
iris auth login

# Or use environment variables
export IRIS_API_KEY=your-key
export IRIS_USER_ID=123      # needed for agents, bloqs, and workflow commands
```

---

## Core Commands

### iris chat — Talk to an IRIS Agent

```bash
# Interactive (prompts to select an agent)
iris chat "hello, what can you help with?"

# Direct to a specific agent
iris chat --agent=11 "summarize my top 5 leads"
iris chat --agent=11 --bloq=217 "what's in my knowledge base?"
iris chat -a 23 "run a competitor analysis"

# With no-rag flag (skip knowledge base lookup)
iris chat --agent=11 --no-rag "quick question"
```

### iris agents — Manage Platform Agents

```bash
iris agents list                          # list all your agents
iris agents list --search "sales"         # filter by name
iris agents get 11                        # show agent details
iris agents create                        # interactive create
iris agents create --name "My Agent" --model gpt-4.1-nano --bloq-id 217
iris agents chat 11 "hello"              # quick single-message chat
```

### iris leads — CRM Lead Management

```bash
iris leads list                           # list all leads
iris leads list --status Active           # filter by status (Active, Won, Lost)
iris leads list --search "acme"           # search by name/company
iris leads get 42                         # show lead details
iris leads search "startup founders"      # full-text search
iris leads create                         # interactive create
iris leads create --name "Jane Smith" --email jane@acme.com --bloq-id 5
iris leads note 42 "Called today, follow up next week"
```

### iris workflows — Run & Monitor Workflows

```bash
iris workflows list                       # list all workflows
iris workflows run 5                      # run a workflow (interactive query)
iris workflows run 5 --query "research top 10 competitors"
iris workflows run 5 --query "..." --no-wait   # fire and forget
iris workflows status run-abc123          # check run status
iris workflows runs                       # list recent runs
```

### iris bloqs — Knowledge Base Management

```bash
iris bloqs list                           # list all knowledge bases
iris bloqs get 217                        # show bloq details and lists
iris bloqs create                         # interactive create
iris bloqs create --name "Product Docs" --description "Internal docs"
iris bloqs ingest 217 ./document.pdf      # upload a file
iris bloqs ingest 217 ./notes.txt         # upload text
iris bloqs add-item 217 5 "Key insight about our market"
```

### iris schedules — Scheduled Agent Jobs

```bash
iris schedules list                       # list all scheduled jobs
iris schedules list --agent-id 11         # filter by agent
iris schedules get 3                      # show schedule details
iris schedules run 3                      # trigger immediately
iris schedules history 3                  # show run history
iris schedules toggle 3                   # enable/disable a schedule
iris schedules toggle 3 --disable         # explicitly disable
```

### iris marketplace — Skills & Integrations

```bash
iris marketplace search "github"          # search marketplace
iris marketplace featured                 # show featured skills
iris marketplace install github-mcp       # install a skill
iris marketplace browse                   # interactive browser
```

---

## Typical Workflows

### "Analyze my leads and send a follow-up"
```bash
iris leads list --status Active           # see active leads
iris leads get 42                         # review a specific lead
iris chat --agent=11 "draft a follow-up email for lead #42"
iris leads note 42 "Follow-up email drafted and sent"
```

### "Run a research workflow and store results"
```bash
iris workflows run 7 --query "research AI startup landscape Q1 2026"
iris workflows runs                       # check on it
iris bloqs add-item 217 5 "Research complete — see workflow run-xyz"
```

### "Set up a new agent for a client"
```bash
iris bloqs create --name "Client XYZ KB"
iris agents create --name "Client XYZ Assistant" --bloq-id <new-bloq-id>
iris schedules list --agent-id <new-agent-id>
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `IRIS_API_KEY` | Authentication token (or use `iris auth login`) |
| `IRIS_USER_ID` | Your numeric user ID (needed for agents, bloqs, workflows) |
| `IRIS_FL_API_URL` | Override API base (default: `https://apiv2.heyiris.io`) |
| `IRIS_API_URL` | Override IRIS API URL (default: `https://iris-api.heyiris.io`) |

---

## Notes

- The `iris chat` command uses the V5 workflow system via `POST /api/chat/start` then polls `/api/workflows/{id}` until complete (up to `--timeout` seconds, default 300)
- `iris agents` requires `IRIS_USER_ID` (or `--user-id`) because agents are user-scoped
- `iris leads` does NOT require `IRIS_USER_ID` — auth token is sufficient
- `iris bloqs ingest` uses multipart file upload; supports PDF, txt, md, and most document formats
- All commands support `iris auth login` for credential storage, or `IRIS_API_KEY` env var
