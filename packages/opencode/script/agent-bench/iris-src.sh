#!/bin/bash
# This checkout's iris CLI, for the agent benchmark's --cli source (#193064). `run --cwd` in that order:
# bun resolves the project's JSX runtime from its working folder, and `bun --cwd X run` prints usage.
# stderr is filtered of a dependency's dev-only warning (the installed binary never prints it); the exit
# code stays iris's own, because the MCP server reports a non-zero exit as an error.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "${BUN:-bun}" run --cwd "$ROOT" --conditions=browser "$ROOT/src/index.ts" "$@" 2> >(grep -v '^\[baseline-browser-mapping\]' >&2)
