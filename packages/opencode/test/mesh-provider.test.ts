import { describe, expect, test } from "bun:test"
import {
  FORBIDDEN_SERVE_FLAGS,
  acpMeshDecision,
  applyMeshProvider,
  buildServeArgv,
  findMeshBinary,
  meshBaseURL,
  meshConfigState,
  meshPort,
  meshProviderEntry,
  ownerIdFromKeystore,
  parseModelsResponse,
  phiRefusal,
  probeMesh,
  removeMeshProvider,
  type FetchLike,
} from "../src/cli/cmd/mesh-core"

/** Shared compute via Mesh LLM — epic #187246, slices M1 (iris mesh) and M4 (acp overlay). */

describe("meshPort — rule 4: IRIS_MESH_API_PORT everywhere, default 9337", () => {
  test("default, override, and garbage falls back", () => {
    expect(meshPort({})).toBe(9337)
    expect(meshPort({ IRIS_MESH_API_PORT: "19337" })).toBe(19337)
    expect(meshPort({ IRIS_MESH_API_PORT: "abc" })).toBe(9337)
    expect(meshPort({ IRIS_MESH_API_PORT: "70000" })).toBe(9337)
    expect(meshPort({ IRIS_MESH_API_PORT: "0" })).toBe(9337)
  })
  test("base URL is loopback, always", () => {
    expect(meshBaseURL(9337)).toBe("http://127.0.0.1:9337/v1")
  })
})

describe("parseModelsResponse — serving means 200 with a NON-EMPTY data array", () => {
  const url = "http://127.0.0.1:9337/v1/models"
  test("200 + data → serving, ids deduped", () => {
    const p = parseModelsResponse(url, 200, { data: [{ id: "Qwen3-8B-Q4_K_M" }, { id: "Qwen3-8B-Q4_K_M" }, { id: "mesh" }] })
    expect(p.serving).toBe(true)
    expect(p.models).toEqual(["Qwen3-8B-Q4_K_M", "mesh"])
    expect(p.reason).toBeNull()
  })
  test("200 + empty data → not serving (up, no model loaded)", () => {
    const p = parseModelsResponse(url, 200, { data: [] })
    expect(p.serving).toBe(false)
    expect(p.reason).toMatch(/no model/)
  })
  test("200 but not a model list → not serving", () => {
    expect(parseModelsResponse(url, 200, { hello: 1 }).serving).toBe(false)
    expect(parseModelsResponse(url, 200, null).serving).toBe(false)
  })
  test("non-200 → not serving, status named", () => {
    const p = parseModelsResponse(url, 503, { data: [{ id: "x" }] })
    expect(p.serving).toBe(false)
    expect(p.reason).toBe("HTTP 503")
  })
  test("no answer → not serving", () => {
    expect(parseModelsResponse(url, null, null, "timed out after 1500ms").reason).toContain("timed out")
  })
})

describe("probeMesh — never throws", () => {
  test("timeout is a no-answer", async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
    const p = await probeMesh(9337, hang, 30)
    expect(p.serving).toBe(false)
    expect(p.reason).toContain("timed out")
  })
  test("refused is a no-answer", async () => {
    const refuse: FetchLike = () => Promise.reject(new TypeError("ECONNREFUSED"))
    expect((await probeMesh(9337, refuse)).reason).toContain("connection refused")
  })
  test("200 + models, and it asks the loopback URL for the configured port", async () => {
    let asked = ""
    const ok: FetchLike = async (u) => {
      asked = u
      return { status: 200, json: async () => ({ data: [{ id: "m1" }] }) }
    }
    const p = await probeMesh(4242, ok)
    expect(asked).toBe("http://127.0.0.1:4242/v1/models")
    expect(p).toMatchObject({ serving: true, models: ["m1"] })
  })
})

describe("meshProviderEntry — the provider shape IRIS reads", () => {
  test("openai-compatible, loopback, placeholder key, models + virtual `mesh`", () => {
    const e = meshProviderEntry(9337, ["Qwen3-8B-Q4_K_M", "mesh"])
    expect(e.npm).toBe("@ai-sdk/openai-compatible")
    expect(e.options).toEqual({ baseURL: "http://127.0.0.1:9337/v1", apiKey: "mesh-local" })
    expect(Object.keys(e.models).sort()).toEqual(["Qwen3-8B-Q4_K_M", "mesh"])
    expect(e.models.mesh.name).toContain("auto")
    // mirrors upstream `mesh-llm opencode`: every model carries context/output limits
    expect(e.models["Qwen3-8B-Q4_K_M"].limit).toEqual({ context: 32768, output: 4096 })
  })
})

describe("applyMeshProvider / removeMeshProvider — never clobber other keys", () => {
  const user = {
    $schema: "https://opencode.ai/config.json",
    model: "iris/iris-ai",
    enabled_providers: ["iris"],
    disabled_providers: ["opencode"],
    provider: { iris: { npm: "x", options: { baseURL: "https://freelabel.net/api/v6/openai" } } },
    mcp: { a: { type: "local", command: ["x"] } },
  }
  const entry = meshProviderEntry(9337, ["m1"])

  test("use adds provider.mesh, appends to enabled_providers, keeps everything else", () => {
    const next = applyMeshProvider(user, entry)
    expect(next.provider as unknown).toEqual({ ...user.provider, mesh: entry })
    expect(next.enabled_providers).toEqual(["iris", "mesh"])
    expect(next.disabled_providers).toEqual(["opencode"])
    expect(next.model).toBe("iris/iris-ai")
    expect(next.mcp).toBe(user.mcp)
    expect(meshConfigState(next)).toEqual({ present: true, offered: true, baseURL: "http://127.0.0.1:9337/v1" })
    // input not mutated
    expect(user.enabled_providers).toEqual(["iris"])
    expect("mesh" in user.provider).toBe(false)
  })
  test("idempotent", () => {
    const once = applyMeshProvider(user, entry)
    expect(applyMeshProvider(once, entry)).toEqual(once)
  })
  test("no enabled list → none is invented", () => {
    const next = applyMeshProvider({ model: "a/b" } as Record<string, unknown>, entry)
    expect("enabled_providers" in next).toBe(false)
  })
  test("a disabled mesh is lifted by an explicit use", () => {
    const next = applyMeshProvider({ disabled_providers: ["mesh", "opencode"] } as Record<string, unknown>, entry)
    expect(next.disabled_providers).toEqual(["opencode"])
  })
  test("off removes exactly what use added — round trip equals the original", () => {
    expect(removeMeshProvider(applyMeshProvider(user, entry))).toEqual(user)
  })
  test("off on a config without mesh changes nothing", () => {
    expect(removeMeshProvider(user)).toEqual(user)
  })
  test("present-but-filtered is reported as not offered", () => {
    expect(meshConfigState({ provider: { mesh: entry }, enabled_providers: ["iris"] }).offered).toBe(false)
    expect(meshConfigState({ provider: { mesh: entry }, disabled_providers: ["mesh"] }).offered).toBe(false)
  })
})

describe("phiRefusal — rule 3: health data never routes to a mesh", () => {
  test("no signal → allowed", () => {
    expect(phiRefusal({}, null)).toBeNull()
    expect(phiRefusal({ IRIS_PHI_CONTEXT: "0" }, { phi: false })).toBeNull()
  })
  test("env signal refuses and names the rule", () => {
    expect(phiRefusal({ IRIS_PHI_CONTEXT: "1" }, null)).toMatch(/PHI.*never routes to a shared-compute mesh/)
  })
  test('~/.iris/config.json "phi": true refuses', () => {
    expect(phiRefusal({}, { phi: true })).toContain('"phi": true')
  })
})

describe("buildServeArgv — owner-restricted, unpublished, loopback", () => {
  const base = { bin: "/opt/homebrew/bin/mesh-llm", model: "Qwen3-8B-Q4_K_M", port: 9337, ownerKey: "/k.json" }
  test("allowlist trust policy with the owner, headless, loopback port", () => {
    const argv = buildServeArgv({ ...base, trustOwners: ["own1", "own2", "own1"] })
    expect(argv).toEqual([
      "/opt/homebrew/bin/mesh-llm",
      "serve",
      "--model",
      "Qwen3-8B-Q4_K_M",
      "--headless",
      "--port",
      "9337",
      "--owner-key",
      "/k.json",
      "--trust-policy",
      "allowlist",
      "--trust-owner",
      "own1",
      "--trust-owner",
      "own2",
    ])
  })
  test("NEVER --auto, --publish, --discover, --listen-all, or a weaker trust policy", () => {
    const argv = buildServeArgv({ ...base, trustOwners: ["o"], nodeLabel: "studio" })
    for (const f of FORBIDDEN_SERVE_FLAGS) expect(argv).not.toContain(f)
    expect(FORBIDDEN_SERVE_FLAGS).toEqual(
      expect.arrayContaining(["--auto", "--publish", "--listen-all", "require-owned"]),
    )
    // owner-restricted means the ALLOWLIST policy specifically
    expect(argv[argv.indexOf("--trust-policy") + 1]).toBe("allowlist")
    expect(argv.filter((a) => a === "--trust-policy")).toHaveLength(1)
  })
  test("a forbidden flag smuggled in as a value is refused", () => {
    expect(() => buildServeArgv({ ...base, model: "--publish", trustOwners: ["o"] })).toThrow(/--publish/)
    expect(() => buildServeArgv({ ...base, trustOwners: ["o"], nodeLabel: "--auto" })).toThrow(/--auto/)
  })
  test("refuses to build an unrestricted mesh", () => {
    expect(() => buildServeArgv({ ...base, trustOwners: [] })).toThrow(/trusted owner/)
    expect(() => buildServeArgv({ ...base, trustOwners: [" "] })).toThrow(/trusted owner/)
    expect(() => buildServeArgv({ ...base, ownerKey: "", trustOwners: ["o"] })).toThrow(/owner key/)
  })
})

describe("findMeshBinary / ownerIdFromKeystore", () => {
  test("PATH, then ~/.local/bin, then Homebrew, else null", () => {
    const has = (set: string[]) => (p: string) => set.includes(p)
    expect(findMeshBinary("/Users/a", has(["/usr/x/mesh-llm"]), "/usr/x:/usr/bin")).toBe("/usr/x/mesh-llm")
    expect(findMeshBinary("/Users/a", has(["/Users/a/.local/bin/mesh-llm"]), "/usr/bin")).toBe("/Users/a/.local/bin/mesh-llm")
    expect(findMeshBinary("/Users/a", has(["/opt/homebrew/bin/mesh-llm"]), "")).toBe("/opt/homebrew/bin/mesh-llm")
    expect(findMeshBinary("/Users/a", () => false, "/usr/bin")).toBeNull()
  })
  test("reads only owner_id", () => {
    expect(ownerIdFromKeystore({ owner_id: "abc", signing_secret_key: "s" })).toBe("abc")
    expect(ownerIdFromKeystore({})).toBeNull()
    expect(ownerIdFromKeystore(null)).toBeNull()
  })
})

describe("acpMeshDecision — M4: Buzz gets the mesh only when it is really there", () => {
  const serving = parseModelsResponse("u", 200, { data: [{ id: "m1" }] })
  const down = parseModelsResponse("u", null, null, "connection refused")
  test("serving, not PHI, not configured → apply", () => {
    expect(acpMeshDecision({ probe: serving, phi: null, config: {} }).apply).toBe(true)
  })
  test("not serving → change nothing", () => {
    expect(acpMeshDecision({ probe: down, phi: null, config: {} }).apply).toBe(false)
  })
  test("PHI context → change nothing, even when serving", () => {
    expect(acpMeshDecision({ probe: serving, phi: "Refusing: PHI", config: {} }).apply).toBe(false)
  })
  test("user already configured mesh → their entry wins", () => {
    const config = { provider: { mesh: meshProviderEntry(1234, []) } }
    expect(acpMeshDecision({ probe: serving, phi: null, config }).apply).toBe(false)
  })
})
