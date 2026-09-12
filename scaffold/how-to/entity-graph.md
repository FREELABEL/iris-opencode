---
category: Data & Atlas
level: intermediate
tags: [graph, entities, relations, identity, atlas, people]
duration_min: 12
---
# Who is related to whom — the entity graph

`iris bloqs relate` connects **boards**. This connects **people, orgs, places and things** —
and answers questions two hops away, like *"who is Sam's grandfather"*, with a citation
for every hop.

> **Status:** the `assert`, `alias`, `predicates` actions and `--depth` require the graph
> commit shipped in fl-iris-api. Run `atlas:graph predicates` first — if it errors, the
> deploy has not landed and only `extract` / `query` / `list` / `sources` / `merge` are live.

## The one-paragraph version

Every entity is reached through a **mention** that remembers which FIELD it came from, and
every edge names the **record** that justifies it. That is what lets the graph apply the same
visibility rules the record would: an edge derived from a `phi` field is invisible to someone
who cannot see that field, and you are told how many were withheld. Nothing in here is a
claim you cannot trace back to something.

## A name is not a role

This is the distinction the whole thing turns on, and it is easy to get backwards.

| You say | It is | Where it goes |
|---|---|---|
| "Morgan Rivera" | a **name** | `aliases` on the entity |
| "Morgan" | a **name** (shorter) | `aliases` on the entity |
| "Dad" | a **role, from one person's seat** | an **edge**, never an alias |
| "Grandpa" | a **role, from one person's seat** | an **edge**, never an alias |

Put "Dad" in Morgan's alias list and it resolves *Dad → Morgan for every user on the account*.
It is only true from Dana's seat. Roles are edges; edges are read from a viewpoint.

## State a relationship

```bash
iris atlas:graph assert "Sam Rivera" "Dana Rivera" --predicate=child_of \
  --note="Dana is Sam's dad"
iris atlas:graph assert "Dana Rivera" "Morgan Rivera" --predicate=child_of
```

Each assertion writes a record into a `graph-assertions` dataset and the edge cites it, so
you keep who said it, when, and the sentence it came from. `--stated-by` records the source.

See the vocabulary and what each word means from the other side:

```bash
iris atlas:graph predicates
```

An unknown predicate is **refused**, with the known list printed. That is deliberate: free text
cannot be inverted, chained or counted, so it is a note, not a relationship.

## Ask the question

```bash
iris atlas:graph query "Sam Rivera" --depth=2 --role=admin
```

```
Sam Rivera  [person]  ·  0 mentions
  -> child_of        Dana Rivera      (record 4090, field predicate)
  ~> grandchild_of   Morgan Rivera    (derived via Dana Rivera; records 4090, 4091)
```

- `->` / `<-` an edge that was stated, with its record
- `~>` a **derived** relationship — computed, never stored, carrying **both** citations

Derived edges are never written back. Storing an inference as an assertion is how a graph
starts confidently stating things nobody ever said.

## It reads correctly from both sides

One row is stored, in the direction you asserted it. The other side is worded on read:

```bash
iris atlas:graph query "Morgan Rivera" --depth=2 --role=admin
#   <- parent_of        Dana Rivera      ← not "child_of" with an arrow you have to invert
#   ~> grandparent_of   Sam Rivera
```

## Names: aliases and merging

```bash
iris atlas:graph list person                      # find the ids
iris atlas:graph alias 3 --add="M. Rivera"          # a name extraction will never see
iris atlas:graph merge 4 3                        # 4 was a duplicate of 3
```

**Merging keeps the name.** The loser's names become aliases of the survivor, so
`query "Morgan"` still finds Morgan Rivera afterwards and says *"also known as: morgan"*.
Merges are reversible — `unmerge` clears one column.

## The gate

`--role=admin|accountant|operator` reads as staff. **Omit `--role` and you are an untrusted
caller** — that is default-deny on purpose, and it matches what the record lane does.

The gate is applied at **every hop**, not just the first, and withheld edges are counted at
every level:

```
  3 edge(s) withheld — derived from fields this role cannot see
```

Withheld, never blanked or summarised. A smaller graph that does not say it is smaller is
worse than a refusal.

## Build it from data you already have

```bash
iris atlas:graph extract <dataset-slug> --field=name=person --field=city=place
iris atlas:graph sources                 # which dataset put which entities there
iris atlas:graph purge --dataset=<slug> --dry-run   # undo one bad extraction run
```

Extraction only produces **co-occurrence** edges — "these two appeared in the same record" —
which is a fact with a citation, not a relationship. Use `assert` for relationships.

A field marked `phi` or `private` is **never** extracted, even if you name it with `--field`.
A flag must not be able to widen what the schema restricted.

## Gotchas

- **`sources` before you trust it.** A wrong `--field` mapping writes towns into the graph as
  people, and a bad edge is as well-cited as a good one. Ask where the entities came from.
- **An entity type that makes no sense for its dataset is the bug.** A bid table producing
  `person` entities means the mapping is wrong.
- **`--depth` is capped at 4.** A walk with no ceiling is a way to ask for the whole graph.
- **This is not the CRM.** An entity here is not yet joined to a lead or a profile — that link
  is still being built. Do not assume "Morgan Rivera" the entity and "Morgan Rivera" the lead know
  about each other.

## See also

- `iris how-to view bloq-relations` — typed edges between **boards**
- `iris boards relate` — typed edges between **board items** (epics, tickets, bugs)
