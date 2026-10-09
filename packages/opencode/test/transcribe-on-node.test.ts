import { describe, expect, test } from "bun:test"
import { isOnDeviceProvider, lastJsonObject, transcribeOnNode, type NodeIO } from "../src/cli/lib/transcribe-on-node"

// #188318 half 2 / epic #188696 O5: private audio handed to YOUR Hive node. The remote is faked
// so every decision — what runs there, what is accepted back, what is deleted — is checked here.

const T = { host: "100.79.222.57", user: "siralexmayo", via: "tailscale" as const }

function fakeNode(opts: { help: string; reply: string; pushOk?: boolean }) {
  const calls: string[] = []
  const io: NodeIO = {
    run: async (_t, command) => {
      calls.push(command)
      if (command.includes("--help")) return { ok: true, code: 0, stdout: opts.help, stderr: "" }
      if (command.includes("iris transcribe")) return { ok: true, code: 0, stdout: opts.reply, stderr: "" }
      return { ok: true, code: 0, stdout: "", stderr: "" }
    },
    push: async (_t, localPath, remoteDir) => ({
      ok: opts.pushOk ?? true,
      verified: opts.pushOk ?? true,
      localPath,
      remotePath: `${remoteDir}/x.wav`,
      bytes: 10,
      sha256: "a",
      remoteSha256: opts.pushOk === false ? "b" : "a",
      ...(opts.pushOk === false ? { error: "sha256 mismatch" } : {}),
    }),
  }
  return { io, calls }
}

const LOCAL_REPLY = `◈  Transcribe\n{\n  "provider": "whisper.cpp (local)",\n  "private": true,\n  "text": "hello there"\n}\n└  Done\n`

describe("transcribeOnNode", () => {
  test("a node that knows --private gets it, under the sovereign ceiling, and the take is deleted", async () => {
    const { io, calls } = fakeNode({ help: "  --private  never reach a cloud STT", reply: LOCAL_REPLY })
    const r = await transcribeOnNode(T, "/tmp/take.wav", io)
    expect(r).toMatchObject({ ok: true, text: "hello there", provider: "whisper.cpp (local)" })
    const run = calls.find((c) => c.includes("iris transcribe '"))!
    expect(run).toContain("IRIS_TRANSCRIPTION_POLICY=sovereign")
    expect(run).toContain("--private")
    expect(calls.at(-1)).toMatch(/^rm -rf '\/tmp\/iris-private-[0-9a-f]{16}'$/)
  })

  test("an OLDER node without --private still runs sovereign, and is not sent the flag it would choke on", async () => {
    // A strict yargs given an unknown flag prints help and exits 0 — an empty "success".
    const { io, calls } = fakeNode({ help: "  --local  on-device", reply: LOCAL_REPLY })
    const r = await transcribeOnNode(T, "/tmp/take.wav", io)
    expect(r.ok).toBe(true)
    const run = calls.find((c) => c.includes("iris transcribe '"))!
    expect(run).toContain("IRIS_TRANSCRIPTION_POLICY=sovereign")
    expect(run).not.toContain("--private")
  })

  test("a node that reports a cloud provider is refused, and its transcript discarded", async () => {
    const reply = `{"provider": "gpt-transcribe (server)", "text": "leaked"}`
    const { io, calls } = fakeNode({ help: "--private", reply })
    const r = await transcribeOnNode(T, "/tmp/take.wav", io)
    expect(r).toMatchObject({ ok: false, stage: "verify" })
    expect(JSON.stringify(r)).not.toContain("leaked")
    expect(calls.at(-1)).toStartWith("rm -rf ")
  })

  test("a copy whose checksum does not match never runs, and is still cleaned up", async () => {
    const { io, calls } = fakeNode({ help: "--private", reply: LOCAL_REPLY, pushOk: false })
    const r = await transcribeOnNode(T, "/tmp/take.wav", io)
    expect(r).toMatchObject({ ok: false, stage: "push" })
    expect(calls.some((c) => c.includes("iris transcribe '"))).toBe(false)
    expect(calls.at(-1)).toStartWith("rm -rf ")
  })

  test("the node's own refusal comes back as a failure, not as an empty transcript", async () => {
    const reply = `{"success": false, "error": "on_device_failed", "message": "audio was NOT uploaded"}`
    const { io } = fakeNode({ help: "--private", reply })
    const r = await transcribeOnNode(T, "/tmp/take.wav", io)
    expect(r).toMatchObject({ ok: false, stage: "transcribe" })
  })
})

describe("helpers", () => {
  test("lastJsonObject finds the transcript among the CLI's other lines", () => {
    expect(lastJsonObject(LOCAL_REPLY)?.text).toBe("hello there")
    expect(lastJsonObject("no json here")).toBeNull()
  })
  test("only an on-device whisper counts as on-device", () => {
    expect(isOnDeviceProvider("whisper.cpp (local)")).toBe(true)
    expect(isOnDeviceProvider("gpt-transcribe (server)")).toBe(false)
    expect(isOnDeviceProvider("whisper (server)")).toBe(false)
    expect(isOnDeviceProvider(undefined)).toBe(false)
  })
})
