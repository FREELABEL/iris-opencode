# iris-code (IRIS CLI source)

You are working on **iris-code**, the source repository for the **IRIS CLI** — a fork of [opencode](https://github.com/sst/opencode) rebranded and extended as the official CLI for the IRIS platform (heyiris.io). The compiled binary ships as `iris` and installs to `~/.iris/bin/iris`.

## Monorepo layout

- `packages/opencode/` — the CLI itself (TypeScript, Bun runtime)
- `packages/sdk/js/` — JavaScript SDK consumed by the CLI
- `packages/tui/` — Go-based terminal UI
- `install` — bash installer (heredoc-style, ~2k lines) that scaffolds `~/.iris/`
- Default branch: `dev`

## Dev workflow

- Run the CLI from source: `cd packages/opencode && bun dev`
- Regenerate the JS SDK: `./packages/sdk/js/script/build.ts`
- Tests: `cd packages/opencode && bun test`

## Where things live

- **Built-in agents** (`build`, `plan`, `general`, `explore`, etc.): `packages/opencode/src/agent/agent.ts`
- **Per-agent prompt files**: `packages/opencode/src/agent/prompt/*.txt`
- **Per-provider system prompts** (anthropic, codex, gemini, qwen, beast…): `packages/opencode/src/session/prompt/*.txt`
- **System prompt assembly + global rule loading** (AGENTS.md, CLAUDE.md): `packages/opencode/src/session/system.ts`
- **IRIS-specific platform commands**: `packages/opencode/src/cli/cmd/platform-*` and `iris*`
- **MCP integration**: `packages/opencode/src/mcp/`

## Conventions

- ALWAYS use parallel tool calls when applicable
- Keep upstream-mergeable: prefer single-point-of-truth edits over forking many files
- IRIS identity is injected once in `session/system.ts:header()` — don't duplicate it across the per-provider `.txt` prompts
- The installer-shipped end-user `AGENTS.md` (written to `~/.config/opencode/AGENTS.md`) is defined in the `scaffold_agents_md()` function in `install`

## Out of scope

This repo is the IRIS CLI. It is not the broader monorepo it lives inside. Ignore stray references to `fl-api`, `fl-elon-web-ui`, `marketing-sites-ui`, etc. — those live in a separate repo and are unrelated to iris-code.
