# @heyiris/pulse-core

The one copy of the IRIS Heartbeats state model and the Pulse route vocabulary (#189243, #189245,
epic #189242).

Desktop ships from `iris/1.18.23`, the CLI ships from `main`, and Genesis pages ship from neither.
They share no code, so each carried its own copy of "is this agent's heartbeat late, silent,
failing?" and the copies drifted. This package is the versioned copy all three pin.

It is pure: no I/O, no clock reads you did not pass in (`now` is always an argument), no
dependencies. Feed it heartbeat rows as the API returns them (`HeartbeatRow`) and it tells you:

| Export | Answers |
|---|---|
| `stateOf(row, now)` | `late` · `silent` · `failing` · `running` · `ok` · `paused` — late comes from the clock, never from `status` |
| `problemsOf(row, now)` | what is wrong, in words, with the fix |
| `lineOf(row, now)` | the one-line summary a list row shows |
| `silentSince`, `lastBeatAt`, `nextFireAt`, `heldForHours`, `cadenceDrift`, `hoursOf` | the facts behind the state |
| `weekOf(row, now)` | the last seven days: expected wakes, real beats, missed wakes, recorded skips |
| `rollupOf`, `beatSummary`, `sortBeats`, `stripOf` | list-level views |
| `kindOf`, `laundered`, `errorOf`, `toolsOfRun`, `beatStory`, `sectionsOf`, `toolsOf` | one run, read honestly (a "completed" run whose reply is an error is a failed beat) |
| `ago`, `shortAgo`, `untilOf`, `durationOf`, `tokensOf`, `previewOf` | the labels |
| types `HeartbeatRow`, `HeartbeatRun`, `HeartbeatWake`, `BeatState`, `Problem`, `WeekView`, … | |
| `queryHeartbeats(rows, {states, since, agents, now})` | which agents are in which state, and since when — with each match's `line` and `problems` |
| `stateSince(row, now)`, `parseSince("7d", now)`, `BEAT_STATES` | when the current state began (null when the record cannot say); a state that does not exist throws |
| `readHeartbeat(job, runs)`, `readRun`, `isHeartbeatJob`, `unwrap`, `LIVE_STATUSES`, `RUNS_PER_ROW` | fl-api's raw job + execution rows → `HeartbeatRow` (fetch them yourself; this does no I/O) |
| `runScript`, `runStop`, `registerDefault`, `extend`, `scriptFor`, `formatCount` (from `./pulse`) | Pulse: walk a route of Stops over Sources — shut is never 0, a floor is N+, a script is read-only |

## Use it

```ts
import { stateOf, problemsOf, lineOf, type HeartbeatRow } from "@heyiris/pulse-core"

const now = Date.now()
for (const row of rows as HeartbeatRow[]) console.log(stateOf(row, now), lineOf(row, now))
```

Inside this monorepo, depend on it as `"@heyiris/pulse-core": "workspace:*"`. Bun resolves the
`bun` export condition straight to `src/`, so there is nothing to build first.

## In a Genesis page (browser bundle)

`bun run build` writes `dist/pulse-core.iife.js` (~14 KB, ~6 KB gzipped). It is a classic script:
load it with a plain `<script>` tag and everything is on `window.IrisPulseCore`.

```html
<script src="https://<our CDN>/pulse-core/0.2.0/pulse-core.iife.js"></script>
<script>
  const { stateOf, lineOf, weekOf } = window.IrisPulseCore
  const now = Date.now()
  for (const row of heartbeats) render(row.agentName, stateOf(row, now), lineOf(row, now))
</script>
```

Host it under a **versioned path** (`/pulse-core/<version>/…`) and never overwrite one, so a page
that pinned `0.1.0` keeps the rules it was checked against. Genesis CSP blocks third-party script
CDNs (it already refuses webfont CDNs), so serve it from our own origin; the
file can also be inlined into a page's `<script>` if a page must be self-contained.

## Tests

```sh
bun test           # the model tests (ported from Desktop) + the golden test
bun run golden     # regenerate test/fixtures/golden.json — on purpose only, then read the diff
bun run build      # dist/: ESM + .d.ts + the IIFE + pulse-core.cjs (Node require — vendored by the Hive daemon SDK)
```

`test/fixtures/heartbeats.json` is 18 real heartbeats, anonymised (names, boards, report text and
emails replaced; statuses, times, cadences and error classes real). This repo is public — keep any
new fixture anonymised the same way.

`test/fixtures/golden.json` pins, for every fixture row at the capture time, +6 h and +30 h:
state, silentSince, problem kinds, cadence drift, nextFireAt, the summary line and the week's
counts. A change to the model that moves any of those shows up as a diff in review — which is the
point: every consumer moves with it.

## Releasing

Bump `version`, `bun run build`, then `npm publish --access public` from this directory
(the `@heyiris` scope). Consumers pin an exact version.
