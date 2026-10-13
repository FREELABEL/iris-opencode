/**
 * Pulse golden test (#189244).
 *
 * The Pulse routes are being re-expressed as Sources + Stops + PulseScripts. That refactor is only
 * safe if what a person SEES does not move, so this test runs the real CLI — `iris pulse check`
 * and `iris leads pulse`, text and --json — inside a world that cannot vary (fake-world.ts pins
 * the clock and answers every network call; world.ts builds the repos, transcripts and API
 * answers) and compares stdout and stderr byte for byte with files captured from the code BEFORE
 * the refactor.
 *
 * Regenerate (only when an output change is intended, and say why in the commit):
 *   UPDATE_GOLDEN=1 bun test test/pulse-golden
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { NOW, USER_ID, makeWorld, topicRoutes, topicRoutesTextSearch, type World } from "./world"
import { contactRoutes, contactRoutesBlind } from "./world-contact"

const PKG = join(import.meta.dir, "..", "..")
const GOLDEN = join(import.meta.dir, "__golden__")
const UPDATE = process.env.UPDATE_GOLDEN === "1"

interface Case {
  name: string
  world: () => World
  argv: (w: World) => string[]
}

const cases: Case[] = [
  {
    name: "topic-text",
    world: () => makeWorld("topic", { routes: topicRoutes() }),
    argv: (w) => ["pulse", "check", "widget", "--no-push", "--repo", w.repo],
  },
  {
    name: "topic-json",
    world: () => makeWorld("topic", { routes: topicRoutes() }),
    argv: (w) => ["pulse", "check", "widget", "--no-push", "--repo", w.repo, "--json"],
  },
  {
    name: "topic-text-search-atlas-diary",
    world: () => makeWorld("topic2", { diary: false, routes: topicRoutesTextSearch() }),
    argv: (w) => ["pulse", "check", "widget", "--no-push", "--repo", w.repo, "--sources", "diary,bloq,email,gmail", "--days", "40", "--limit", "2"],
  },
  {
    name: "contact-text",
    world: () => makeWorld("contact", { routes: contactRoutes() }),
    argv: () => ["leads", "pulse", "7001"],
  },
  {
    name: "contact-json",
    world: () => makeWorld("contact", { routes: contactRoutes() }),
    argv: () => ["leads", "pulse", "7001", "--json"],
  },
  {
    name: "contact-blind-text",
    world: () => makeWorld("contact-blind", { routes: contactRoutesBlind() }),
    argv: () => ["leads", "pulse", "7001", "--days", "14"],
  },
]

/** Paths of the throwaway world, and Bun's own nag line, are the only things normalised. */
function normalise(text: string, w: World): string {
  return text
    .split(w.root)
    .join("<WORLD>")
    .split("\n")
    .filter((l) => !l.startsWith("[baseline-browser-mapping]"))
    .join("\n")
}

async function runCli(c: Case): Promise<{ out: string; unmatched: string }> {
  const w = c.world()
  try {
    const proc = Bun.spawn(
      [process.execPath, "--conditions=browser", "--preload", join(import.meta.dir, "fake-world.ts"), "./src/index.ts", ...c.argv(w)],
      {
        cwd: PKG,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Built from nothing, so the host's sessions, tokens and config cannot leak in.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: w.home,
          TZ: "UTC",
          LANG: "C.UTF-8",
          NO_COLOR: "",
          XDG_DATA_HOME: join(w.home, ".local", "share"),
          XDG_CONFIG_HOME: join(w.home, ".config"),
          XDG_CACHE_HOME: join(w.home, ".cache"),
          XDG_STATE_HOME: join(w.home, ".local", "state"),
          IRIS_API_URL: "http://api.golden.test",
          IRIS_FL_API_URL: "http://api.golden.test",
          BRIDGE_URL: "http://bridge.golden.test",
          IRIS_API_KEY: "golden-key",
          IRIS_USER_ID: String(USER_ID),
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          GOLDEN_NOW: NOW,
          GOLDEN_ROUTES: w.routes,
          GOLDEN_LOG: w.log,
        },
      },
    )
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    const out = `== exit ${code}\n== stdout\n${normalise(stdout, w)}\n== stderr\n${normalise(stderr, w)}\n`
    const unmatched = existsSync(w.log) ? readFileSync(w.log, "utf8") : ""
    return { out, unmatched }
  } finally {
    w.dispose()
  }
}

// The fixtures read iMessage as "macOS only" — on a Mac the same run would look for a database.
describe.skipIf(process.platform !== "linux")("pulse golden output (#189244)", () => {
  for (const c of cases) {
    test(
      c.name,
      async () => {
        const { out, unmatched } = await runCli(c)
        const file = join(GOLDEN, `${c.name}.txt`)
        if (UPDATE) {
          mkdirSync(GOLDEN, { recursive: true })
          writeFileSync(file, out)
          // Requests the fixture does not answer (they get a 404). Printed to grow a fixture by.
          if (unmatched && process.env.GOLDEN_DEBUG) console.error(`${c.name} unmatched:\n${unmatched}`)
          return
        }
        // git renders a +0000 commit date as "+00:00" or "Z" depending on its version (2.43 here,
        // newer on CI) — same instant, so the comparison is made on one spelling.
        const z = (s: string) => s.replace(/(T\d\d:\d\d:\d\d)\+00:00/g, "$1Z")
        expect(z(out)).toBe(z(readFileSync(file, "utf8")))
      },
      120_000,
    )
  }

  test("is deterministic: two runs of the same case agree", async () => {
    const c = cases.find((x) => x.name === "contact-text")!
    const [a, b] = await Promise.all([runCli(c), runCli(c)])
    expect(a.out).toBe(b.out)
  }, 120_000)
})
