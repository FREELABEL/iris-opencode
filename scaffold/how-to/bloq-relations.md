# Link bloqs together — relations, filtering, and the graph view

IRIS lets you connect bloqs (projects/knowledge bases) to each other with **typed
relations** — e.g. a "MAYO — Life Atlas" bloq with child bloqs for Health, Legal,
Vehicles. You can create, remove, list, and filter these from the CLI, and see them
visualized in the graph view on the web.

Requires `iris` **v1.3.121+** (`iris --version`; run `iris update` if older).

## The six relation types

| Type | Meaning | Directional? |
|---|---|---|
| `parent` | The `from` bloq is the parent of the `to` bloq | one-way |
| `feeds_into` | The `from` bloq feeds into the `to` bloq (a flow) | one-way |
| `sibling` | The two bloqs are peers at the same level | two-way |
| `affiliated` | Loosely associated | two-way |
| `partner` | A strong two-way relationship | two-way |
| `mirrors` | The two bloqs mirror each other | two-way |

**Two-way (symmetric) types auto-create the reciprocal link** — relate A→B as
`sibling` and B already shows A as a sibling too. **One-way (directional) types**
create a single edge in the stated direction. You only need **write access to the
`from` bloq** to create or remove a relation.

## Create a link

```bash
iris bloqs relate <from-id> <to-id> --type=<type>
```

Examples:
```bash
iris bloqs relate 544 400 --type=parent       # bloq 544 is the parent of bloq 400
iris bloqs relate 546 547 --type=sibling      # 546 and 547 are peers (both directions)
iris bloqs relate 170 364 --type=feeds_into   # 170 feeds into 364 (one-way)
```

Relating the same pair + type twice is a safe no-op (idempotent).

## List / view relations

```bash
iris bloqs relations <id>                      # all relations, grouped by type (tree output)
iris bloqs relations <id> --type=sibling       # only sibling links
iris bloqs relations <id> --direction=from     # only links this bloq points OUT from
iris bloqs relations <id> --direction=to       # only links pointing IN to this bloq
iris bloqs relations <id> --json               # machine-readable (for scripting)
```

`--direction` is `from` | `to` | `both` (default `both`). Grouped output looks like:

```
Relations for Bloq #544:
parent
  └─ → Becoming a Better Me
sibling
  ├─ ↔ Health & Wellbeing
  └─ ↔ Legal & Court
```

The arrow shows direction: `→` this bloq points out, `←` points in, `↔` two-way.
A symmetric relation lists **once**, not twice.

## Remove a link

```bash
iris bloqs unrelate <from-id> <to-id> --type=<type>
```

For two-way types this removes both sides. Example:
```bash
iris bloqs unrelate 546 547 --type=sibling
```

## See it visualized (web)

1. Open the bloq's board at `web.freelabel.net` (or your IRIS host).
2. Switch the view mode (top-right dropdown) to **Graph**.
3. Related bloqs appear as indigo nodes; each relation type has its own edge color
   and dash style (sibling/mirrors are dashed). Hover a node for details, drag to
   rearrange, scroll to zoom.
4. Use the **+ Link** button in the graph header to create a relation from the UI —
   pick a type (with an animated preview of the pattern) and search for the target
   bloq. No terminal needed.
5. The header filter chips let you toggle node types on/off; only types actually
   present in this bloq's graph are shown.

## Tips

- Find bloq IDs with `iris bloqs list` (or `iris bloqs search <query>`).
- `--json` on any of these is stable output for scripts/agents.
- Set `IRIS_USER_ID` (or pass `--user-id`) if acting on behalf of a specific user.
- Relations are bloq-to-bloq only. Linking leads/items/agents across bloqs is a
  separate (planned) capability, not these commands.
