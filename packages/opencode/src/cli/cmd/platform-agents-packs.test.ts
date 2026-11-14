import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import {
  AgentsInstallCommand,
  AgentsPacksCommand,
  checkPackInput,
  connectFirstMessage,
  explainPackError,
  fetchCatalog,
  formatPlan,
  installRequestBody,
  missingIntegrations,
  parsePairs,
  requestInstall,
  type PackSummary,
} from "./platform-agents-packs"
import { PlatformAgentsCommand } from "./platform-agents"

/**
 * `iris agents install` / `iris agents packs` (#191436) against a fake fl-api that mirrors
 * AgentPackController + PackInstaller (fl-api #189): catalog, dry-run plan, idempotent install per
 * (user, pack, install_key), 422 with sentence errors for unknown variables.
 */

const PACK: PackSummary = {
  name: "long-term-investing-advisor",
  version: "1.0.0",
  title: "Long-Term Strategy & Options Advisor",
  variables: {
    owner_name: { label: "Whose advisor is this? (first name)", type: "string", required: true, max_length: 60 },
    horizon: { label: "Investing horizon", type: "string", required: false, default: "10+ years", max_length: 40 },
  },
  intake: [
    { id: "goal", question: "What is the goal?", list: "Investment Policy", required: false },
    { id: "capital", question: "How much is invested now?", list: "Investment Policy", required: false },
  ],
  integrations: [],
}

function fakeFlApi() {
  const installs = new Map<string, any>()
  const calls: string[] = []
  let nextBoard = 900
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const fetcher = async (path: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${path}`)
    if (path === "/api/v1/users/7/agent-packs") return json(200, { success: true, message: "OK", data: { packs: [PACK] } })
    const m = path.match(/^\/api\/v1\/users\/7\/agent-packs\/([^/]+)\/install$/)
    if (m) {
      const body = JSON.parse(String(init.body ?? "{}"))
      if (m[1] !== PACK.name) return json(422, { code: 422, success: false, message: "Unknown pack", errors: [`Unknown pack '${m[1]}'. Available: ${PACK.name}.`] })
      for (const k of Object.keys(body.variables ?? {})) {
        if (!(k in PACK.variables!)) return json(422, { code: 422, success: false, message: "x", errors: [`Unknown variable '${k}'. This pack takes: owner_name, horizon.`] })
      }
      const key = body.install_key ?? "default"
      const existing = installs.get(key)
      if (body.dry_run) {
        return json(200, {
          success: true,
          data: {
            dry_run: true,
            plan: {
              pack: PACK.name, version: "1.0.0", install_key: key, already_installed: existing ?? null,
              board: { name: `${body.variables.owner_name} — Desk`, lists: [{ name: "Investment Policy", items: ["IPS"] }, { name: "Holdings", items: [] }] },
              agent: { name: "Advisor", model: "gpt-4.1-nano", tools: ["manageBloqItems"], heartbeat: { mode: "off" } },
              integrations: [], disclaimer: "Not financial advice.",
            },
          },
        })
      }
      if (existing) return json(200, { success: true, message: "Already installed — nothing created.", data: { created: false, install: existing } })
      const install = { id: installs.size + 1, pack: PACK.name, version: "1.0.0", install_key: key, status: "installed", bloq_id: nextBoard++, agent_id: 4000 + installs.size }
      installs.set(key, install)
      return json(201, { success: true, message: "Pack installed.", data: { created: true, install } })
    }
    return json(404, { message: "no route" })
  }
  return { fetcher, calls, installs }
}

describe("parsePairs", () => {
  test("splits on the first = only, so answers may contain =", () => {
    expect(parsePairs(["owner_name=Sam", "goal=target=2M"], "var")).toEqual({ pairs: { owner_name: "Sam", goal: "target=2M" } })
    expect(parsePairs(undefined, "var")).toEqual({ pairs: {} })
  })
  test("a pair with no name is a sentence, not a crash", () => {
    expect(parsePairs(["oops"], "answer")).toEqual({ error: '--answer needs name=value (got "oops").' })
  })
})

describe("checkPackInput — refused before any write, in client language", () => {
  test("unknown variable names what the pack does take", () => {
    expect(checkPackInput(PACK, { owner_name: "Sam", foo: "1" }, {})).toEqual(["Unknown variable foo — this pack takes: owner_name, horizon."])
  })
  test("unknown intake question names the questions", () => {
    expect(checkPackInput(PACK, { owner_name: "Sam" }, { nope: "x" })[0]).toBe("Unknown intake question nope — this pack asks: goal, capital.")
  })
  test("a missing required variable says which flag to pass — unless someone will be asked", () => {
    expect(checkPackInput(PACK, {}, {})).toEqual(["Missing owner_name (Whose advisor is this? (first name)) — pass --var owner_name=…"])
    expect(checkPackInput(PACK, {}, {}, { interactive: true })).toEqual([])
  })
  test("valid input passes", () => {
    expect(checkPackInput(PACK, { owner_name: "Sam" }, { goal: "2M by 2045" })).toEqual([])
  })
})

describe("integrations", () => {
  const withSlack: PackSummary = { ...PACK, integrations: [{ key: "slack", required: true, reason: "to message you" }, { key: "gmail", required: false }] }
  test("only required, unconnected integrations are missing", () => {
    expect(missingIntegrations(withSlack, ["gmail"]).map((i) => i.key)).toEqual(["slack"])
    expect(missingIntegrations(withSlack, ["Slack"])).toEqual([])
  })
  test("Connect X first, with the command", () => {
    expect(connectFirstMessage(missingIntegrations(withSlack, []))).toBe("Connect slack first (to message you): iris integrations connect slack")
  })
})

describe("explainPackError never shows a raw body", () => {
  test("server sentences are reworded to the CLI's form", () => {
    expect(explainPackError(422, { errors: ["Unknown variable 'foo'. This pack takes: owner_name, horizon."] })).toEqual([
      "Unknown variable foo — this pack takes: owner_name, horizon.",
    ])
  })
  test("auth, 5xx and exception text become next steps", () => {
    expect(explainPackError(401, {})[0]).toContain("iris auth login")
    expect(explainPackError(500, { message: "SQLSTATE[42S02] base table" })[0]).toContain("all-or-nothing")
    expect(explainPackError(400, { message: "Illuminate\\Database\\QueryException at line 3" })[0]).not.toContain("Illuminate")
  })
})

describe("install round-trip against a fake fl-api", () => {
  test("the catalog lists the reference pack", async () => {
    const api = fakeFlApi()
    const r = await fetchCatalog(7, api.fetcher)
    expect("packs" in r && r.packs.map((p) => p.name)).toEqual([PACK.name])
  })

  test("--dry-run returns the plan and writes nothing", async () => {
    const api = fakeFlApi()
    const r = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam" }, answers: {}, dryRun: true }, api.fetcher)
    expect(r.kind).toBe("plan")
    expect(api.installs.size).toBe(0)
    const lines = formatPlan((r as any).plan)
    expect(lines[0]).toContain("long-term-investing-advisor v1.0.0")
    expect(lines.join("\n")).toContain("Board:  Sam — Desk")
    expect(lines.join("\n")).toContain("Runs:   only when you ask it")
  })

  test("a live install returns the board URL and the agent id", async () => {
    const api = fakeFlApi()
    const r = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam" }, answers: { goal: "2M" }, key: "sam" }, api.fetcher)
    expect(r.kind).toBe("installed")
    const i = r as Extract<typeof r, { kind: "installed" }>
    expect(i.created).toBe(true)
    expect(i.install.agent_id).toBe(4000)
    expect(i.boardUrl).toMatch(/\/atlas\?project=900$/)
    expect(api.calls).toEqual([`POST /api/v1/users/7/agent-packs/${PACK.name}/install`])
  })

  test("re-running with the same --key is idempotent; a new key installs a second copy", async () => {
    const api = fakeFlApi()
    const first = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam" }, answers: {}, key: "sam" }, api.fetcher)
    const again = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam" }, answers: {}, key: "sam" }, api.fetcher)
    expect((again as any).created).toBe(false)
    expect((again as any).install.bloq_id).toBe((first as any).install.bloq_id)
    const other = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam" }, answers: {}, key: "second" }, api.fetcher)
    expect((other as any).created).toBe(true)
    expect(api.installs.size).toBe(2)
  })

  test("an unknown variable the server refuses comes back as a sentence", async () => {
    const api = fakeFlApi()
    const r = await requestInstall(7, PACK.name, { variables: { owner_name: "Sam", foo: "1" }, answers: {} }, api.fetcher)
    expect(r).toEqual({ kind: "error", errors: ["Unknown variable foo — this pack takes: owner_name, horizon."] })
  })

  test("the request body carries install_key and dry_run only when set", () => {
    expect(installRequestBody({ variables: {}, answers: {} })).toEqual({ variables: {}, answers: {} })
    expect(installRequestBody({ variables: { a: "1" }, answers: {}, key: "k", dryRun: true })).toEqual({ variables: { a: "1" }, answers: {}, install_key: "k", dry_run: true })
  })
})

describe("help text", () => {
  async function help(argv: string): Promise<string> {
    let out = ""
    await yargs()
      .scriptName("iris").wrap(null)
      .command(PlatformAgentsCommand as any)
      .exitProcess(false)
      .parse(argv, {}, (_err, _argv, output) => { out = output })
    return out
  }

  test("agents install --help explains the flags and has an example", async () => {
    const h = await help("agents install --help")
    for (const s of ["--var", "--answer", "--key", "--dry-run", "Examples:", "iris agents install long-term-investing-advisor"]) expect(h).toContain(s)
  })

  test("agents packs is registered with an example", async () => {
    const h = await help("agents packs --help")
    expect(h).toContain("--installed")
    expect(h).toContain("iris agents packs")
    expect(String((AgentsPacksCommand as any).describe)).toContain("agent packs")
    expect(String((AgentsInstallCommand as any).command)).toBe("install [pack]")
  })
})
