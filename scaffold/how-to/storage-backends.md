---
category: Data & Atlas
level: advanced
tags: [storage, client-work, security, architecture]
duration_min: 18
---
# How to: Put a client's data on their own database or bucket (Provider Proxy)

## What this does

Points one workspace's Atlas objects at storage the **client owns** — their PostgreSQL, their S3
bucket — instead of the shared IRIS store, and moves the existing objects across.

This is the **data residency** answer: when a client needs their records inside their own
infrastructure, in their own region, under their own retention policy, this is the mechanism. It
is also the exit — per-workspace routing is only a real promise if a customer can also leave.

Two commands, and the order matters:

| Step | Command | What it does |
|---|---|---|
| 1 | `storage:bind-workspace` | changes where the workspace **reads and writes** |
| 2 | `storage:migrate-workspace` | **moves the objects** that are already there |

Binding moves nothing. Migrating rebinds nothing. Doing only the first makes existing data
invisible; doing only the second copies data the workspace will never read.

## ⚠️ This is not `iris workspace bind`

`iris workspace` means **Google Workspace identity sync** — matching agents to a Google directory.
It has nothing to do with storage, and `iris find "bind a backend"` will point you at it. The
storage commands are Artisan commands on fl-api:

```
docker exec fl-api php artisan storage:bind-workspace ...
railway ssh -s fl-api -- php artisan storage:migrate-workspace ...
```

Artisan rather than an `iris` verb for two reasons: the noun `workspace` was already taken by
something unrelated, and this is the shape that works in production over `railway ssh` with clean
argv.

## Three modes, and which one you actually want

Atlas core data has three configurations. They are not a ladder — mode 3 is not "more" than
mode 2, it is a different question — and choosing by vibe is how a client ends up with the
wrong one.

| | mode | where the records live | when |
|---|---|---|---|
| 1 | **default** | shared IRIS store | everything, unless there is a reason not to |
| 2 | **external** | the client's own Postgres / S3 | data residency: their infrastructure, their region, their retention policy |
| 3 | **parallel** | shared IRIS **and** a continuous feed out to their warehouse | they want to ANALYSE the data elsewhere, not host it |

**The question that separates 2 from 3:** does the client want to *hold* the data, or *query*
it? "Put it in our Supabase so we can run BI on it" is mode 3 — answering it with mode 2 moves
their operational store onto their infrastructure to solve a reporting problem, and now every
read path depends on their database being up.

Modes 1 and 2 are exclusive: `storage_driver` resolves to exactly one backend. Mode 3 is not a
third driver — it sits alongside whichever of 1 or 2 is in force.

### Mode 3 — the parallel feed

The dataset read becomes a change feed with `updated_since`:

```
GET /api/v1/atlas/datasets/<slug>?updated_since=<iso8601>&include_deleted=1
```

- ordered `(updated_at ASC, id ASC)` — a cursor feed ordered any other way drops rows that move
  across a page boundary mid-scan
- the cursor is **strictly greater-than**, so a consumer that advances to `next_cursor` does not
  re-read its boundary row forever
- `include_deleted` emits soft-deleted rows so the replica can tombstone them. Without it a feed
  cannot express a delete at all, and the downstream copy silently keeps every row it has ever
  seen while both sides report success
- tombstones are **staff-only and never served on a public read**. `meta.include_deleted_refused`
  says so explicitly, because "refused" and "there were no deletes" must not look alike
- `meta.next_cursor` is where to resume, emitted rather than left to the caller — a caller
  deriving it from an empty page has nothing to derive from

**Writes still go through Atlas.** If the client's own pipeline needs to create rows, it posts to
the dataset API and Atlas remains the single writer. That is what keeps mode 3 free of conflict
resolution: there is one authority, and the warehouse is downstream of it.

## What you keep when the data leaves (the question every client asks)

Mode 2 does **not** hand the processing to the client. The record body moves to their backend and
the shared row is redacted to a pointer, but the **MySQL sidecar index is built from the full
data on the initial save and stays** — so `list`, `filter` and `sort` keep working against shared
infrastructure while the data itself sits on theirs.

One deliberate exception, and it is worth saying out loud to a client rather than discovering it
together: a field marked **`sensitive`** is kept OUT of the shared index on a residency-bound
workspace (#163741). `value_text` lives in shared IRIS MySQL regardless of where the body went,
so indexing a sensitive field would move PHI into shared infrastructure by the side door.
**The price is that index-based search does not work on that one field.** That is the trade, and
it is the right way round.

Both halves are asserted in `tests/Feature/Workspace/ExternalStorageFieldIndexTest.php` — the
claim used to live only in a docblock, and it is order-dependent (the indexer runs on `saved`,
redaction happens after), so it is tested rather than trusted.

### Which mode is a workspace on right now?

```
$ php artisan storage:atlas-mode            # only workspaces NOT on the shared store
$ php artisan storage:atlas-mode 42         # one workspace, in full
$ php artisan storage:atlas-mode 42 --json
```

It prints **configured vs resolved** and **exits non-zero when they disagree** — which is the
only thing that detects the silent fallback described below. Read-only: it names the commands
that change a mode rather than running them, because binding moves customer data.

## Prerequisites

- The workspace id (`workspaces.id`)
- An **Integration** holding the client's credentials, and its id
- For a fresh client database: nothing else — the table is created for you with `--create-schema`

Credentials come from the workspace's storage Integration:

| Backend | Required keys |
|---|---|
| `postgres` | `host`, `database` (plus optional `port`, `username`, `password`, `sslmode`, `schema`) |
| `byo-s3` | `access_key_id`, `secret_access_key`, `bucket` (plus optional `endpoint`, `region`, `prefix`) |
| `sqlite` | `database` (a path) |
| `iris` | none — the shared default |

## Steps

**1. See what backends exist**

```
$ php artisan storage:migrate-workspace --list-drivers
Available drivers: iris, byo-s3, postgres, sqlite
```

**2. Bind the workspace**

```
$ php artisan storage:bind-workspace 42 --driver=postgres --integration=17
```

It builds the driver **before** saving and refuses if it cannot. Then it re-resolves through the
real read path and tells you where reads actually land. See the warning below for why that
matters.

**3. Dry-run the migration**

```
$ php artisan storage:migrate-workspace 42 --to=postgres --collection=notes --create-schema --dry-run
```

`--create-schema` creates the object table on the destination if it is missing — needed for a
fresh client database. It is never implicit: provisioning tables as a side effect of a write means
a mistyped connection name creates a database nobody intended to touch.

**4. Migrate, keeping the originals**

```
$ php artisan storage:migrate-workspace 42 --to=postgres --collection=notes
```

The default keeps the source. Every object is written, **read back from the destination**, and
only then counted. Objects that fail are listed **by name**, and their originals are untouched.

**5. Only once you trust it, remove the originals**

```
$ php artisan storage:migrate-workspace 42 --to=postgres --collection=notes --delete-source
```

This prompts. Nothing is deleted that was not read back first.

## ⚠️ A bad binding does not announce itself

The read path falls back to the shared IRIS store for any backend it cannot build — deliberately,
so a misconfigured workspace never hard-fails a page render. The consequence is that **a broken
binding behaves perfectly**: it saves, it reads, it writes, against the wrong backend,
indefinitely, and nothing surfaces.

That is why `storage:bind-workspace` refuses to save a binding it cannot build, and re-resolves
afterwards to confirm. If you ever bind by editing the database directly, you lose both checks.

**To detect one that is already live**, `php artisan storage:atlas-mode` compares configured
against resolved and exits 1 when they differ — run it on a schedule and a fallback alarms
instead of sitting there behaving perfectly.

## What the refusals mean

| Message | Cause |
|---|---|
| `Could not build destination driver 'X'` | unknown backend, or its credentials are incomplete |
| `source and destination are both 'iris'` | nothing to move — refused rather than reported as a no-op success |
| `Refusing to bind: 'X' cannot be built` | the Integration is missing required keys (see the table above) |
| `Bound, but reads resolve to 'iris'` | saved, but unusable at read time — the fallback |
| `STOPPED AT THE --limit CAP` | a partial run. Re-run without `--limit` |

All of these exit **non-zero**. A partial migration never reports as complete.

## Detaching

```
$ php artisan storage:bind-workspace 42 --detach
```

Returns the workspace to the shared store. **Migrate first if the data is still needed** —
detaching redirects reads only; objects on the old backend are not copied and simply stop being
visible, which from the outside is indistinguishable from data loss.

## Testing it without a client

Both backends run locally, which is how the migration path is tested without a cloud account:

```
# PostgreSQL
$ docker compose up -d postgres-n8n

# S3 (MinIO speaks the real S3 API)
$ docker run -d --name pp-minio --network fl-docker-dev_fl-network \
    -e MINIO_ROOT_USER=pptest -e MINIO_ROOT_PASSWORD=pptest12345 minio/minio server /data

$ docker exec fl-api php artisan test --filter=Workspace
```

The suites **skip loudly** when a backend is absent rather than reporting green, and the skip
message names the command to start it.

What local testing does **not** cover: IAM denials, throttling, cross-region latency and eventual
consistency. A first migration onto a customer's real bucket is still a first — keep the source.

## Related

- `atlas-datasets.md` — the data being stored
- `bloq-access-control.md` — who can see a workspace's data
