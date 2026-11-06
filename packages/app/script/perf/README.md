# Desktop perf suite

Real Chrome, driven by Playwright, against a **compiled** build of the app: one production bundle served from the same origin as the engine, the way the desktop app loads it. The Vite dev server is about 3× slower to first paint and does not tell you what users get.

Written for #192535 / #192623. Run it before a desktop release and compare against the previous release.

## Run it

```bash
# 1. an engine (compiled, from the release commit) with a password
OPENCODE_SERVER_PASSWORD=<pw> packages/opencode/dist/opencode-<os>-<arch>/bin/iris serve --port 4096 --hostname 127.0.0.1

# 2. a production build of the app, served same-origin with that engine
cd packages/app && bunx vite build --outDir /tmp/iris-dist
node script/perf/serve.mjs /tmp/iris-dist 5276 http://127.0.0.1:4096 127.0.0.1

# 3. the suite (token = base64 of "opencode:<pw>")
node script/perf/iris-perf.mjs "http://127.0.0.1:5276/?auth_token=<token>" all 30
```

It prints a PASS/FAIL table and writes `perf-<scenario>.json` to `$IRIS_PERF_OUT`.

| Scenario   | What it does                                                                                | Pass if                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `setup`    | opens a throwaway project with the two test chats, saves the signed-in state                | the project is open                                                                     |
| `cold`     | launch → Home, panel open and closed, 5 runs                                                | Home ≤ 2.5 s, worst freeze ≤ 400 ms                                                     |
| `nav`      | Home → chat → Home → chat, N loops                                                          | shell never rebuilt; switches ≤ 300 / 800 ms (p50/p95); heap and DOM nodes flat (≤ 15%) |
| `drag`     | 200 rapid divider drags                                                                     | worst freeze ≤ 150 ms; saved split matches screen; layout/style time reported           |
| `churn`    | open/close the panel and switch products 50×                                                | closed = unmounted; no Atlas requests while closed; no page errors                      |
| `tabs`     | 20 restored chat tabs, then launch                                                          | Home ≤ 3 s, stays on Home, all chats in the strip                                       |
| `slow`     | every engine call +2 s                                                                      | Home ≤ 6 s; nothing navigates on its own                                                |
| `split`    | split view, 2 columns, window resize                                                        | 2 columns; shell panel steps aside; no "too narrow"                                     |
| `atlasbig` | Atlas on a board with a 1,000+ card list (`IRIS_PERF_BIG_BLOQ`), in Board / List / Timeline | DOM nodes ≤ 20k; worst freeze ≤ 400 ms; no page errors                                  |

## Environment

| Variable             | Default                  |                                                               |
| -------------------- | ------------------------ | ------------------------------------------------------------- |
| `IRIS_PERF_ENGINE`   | app host, port 4096      | engine the app talks to (setup creates test chats through it) |
| `IRIS_PERF_PROJECT`  | `$IRIS_PERF_OUT/proj`    | **throwaway** folder for test chats; never real work          |
| `IRIS_PERF_OUT`      | `$TMPDIR/iris-perf`      | results and saved state                                       |
| `IRIS_PERF_CHROME`   | macOS Google Chrome      | the Chrome binary                                             |
| `IRIS_PERF_WORKTREE` | the repo root            | where bun installed Playwright                                |
| `IRIS_PERF_BIG_BLOQ` | unset (`atlasbig` skips) | a board with a very large list (IRIS CLI Bug Reports is #297) |

## Rules this suite learned the hard way

- **A wait never returns an element.** `waitForFunction(() => document.querySelector(x))` and `waitForSelector(x)` return handles that DevTools keeps alive, and one element pins its whole detached page. That once made this suite report a memory leak that it was itself causing. Return booleans; use `locator(x).waitFor()`.
- **One Chrome per run.** Each `chromium.launch` on macOS wakes `syspolicyd`/`tccd`. Ten in a row took a shared machine to a load of 47. Scenarios use fresh contexts in one browser.
- **Read the machine's load before reading a number.** A divider-drag freeze of 505 ms on a busy machine was 133 ms on a calm one. Compare builds by alternating them in rounds, and prefer load-independent measures (layout/style time from `Performance.getMetrics`) over "worst freeze".
- **Tests find elements by name, not by nesting.** The shell's right-hand container is `[data-component=iris-shell-panel]`.

## `leak-find.mjs`: what holds a page after you leave it?

It tags each Home root, chat root and tooltip trigger with a named marker object, loops Home ⇄ chat, takes a heap snapshot, and prints the shortest retainer path from a GC root to each marker still alive. A path that starts at `(Global handles) — DevTools console` is the test holding the page, not the app.

```bash
node --max-old-space-size=8192 script/perf/leak-find.mjs "$PWD/../.." "<app-url>?auth_token=<token>" 6
```
