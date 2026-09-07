import { describe, expect, it } from "bun:test"
import { decideUpdate, type UpdateContext } from "./update-policy"

const ctx = (over: Partial<UpdateContext> = {}): UpdateContext => ({
  mode: "ask",
  trigger: "interval",
  available: "1.18.41",
  declined: undefined,
  canInstallSilently: true,
  ...over,
})

describe("the nag", () => {
  it("asks once about a version", () => {
    expect(decideUpdate(ctx())).toEqual({ action: "prompt" })
  })

  it("does not ask twice about the SAME version — the whole complaint", () => {
    expect(decideUpdate(ctx({ declined: "1.18.41" }))).toEqual({
      action: "none",
      reason: "already-declined",
    })
  })

  it("asks again about a NEW version", () => {
    // Declining 1.18.40 says nothing about 1.18.41, which may be the fix they are waiting
    // for. Remembering "no" forever would be a different bug in the opposite direction.
    expect(decideUpdate(ctx({ available: "1.18.41", declined: "1.18.40" }))).toEqual({
      action: "prompt",
    })
  })

  it("stays quiet at startup too, not just on the six-hour timer", () => {
    // The original bug hit both paths — relaunching the app was enough to be asked again.
    expect(decideUpdate(ctx({ trigger: "startup", declined: "1.18.41" }))).toEqual({
      action: "none",
      reason: "already-declined",
    })
  })
})

describe("mode", () => {
  it("auto installs without asking, where that is not disruptive", () => {
    expect(decideUpdate(ctx({ mode: "auto" }))).toEqual({ action: "install-silently" })
  })

  it("auto ignores an earlier decline — the user changed their mind by switching it on", () => {
    expect(decideUpdate(ctx({ mode: "auto", declined: "1.18.41" }))).toEqual({
      action: "install-silently",
    })
  })

  it("auto degrades to asking where installing would close the app", () => {
    // Windows/Linux: the installer terminates the running app to replace files. Silently
    // doing that mid-work is a worse interruption than the dialog being removed, so the
    // setting degrades honestly rather than doing something destructive under its own name.
    expect(decideUpdate(ctx({ mode: "auto", canInstallSilently: false }))).toEqual({
      action: "prompt",
    })
  })

  it("auto on a non-silent platform still only asks ONCE per version", () => {
    expect(decideUpdate(ctx({ mode: "auto", canInstallSilently: false, declined: "1.18.41" }))).toEqual({
      action: "none",
      reason: "already-declined",
    })
  })

  it("off never interrupts on a timer", () => {
    expect(decideUpdate(ctx({ mode: "off" }))).toEqual({
      action: "none",
      reason: "checks-disabled",
    })
    expect(decideUpdate(ctx({ mode: "off", trigger: "startup" }))).toEqual({
      action: "none",
      reason: "checks-disabled",
    })
  })
})

describe("a manual check is a question, and must always get an answer", () => {
  it("prompts even when updates are switched off", () => {
    // Someone who opens the menu and clicks "Check For Updates..." has asked directly.
    // Silence would read as a broken app, not as a respected preference.
    expect(decideUpdate(ctx({ mode: "off", trigger: "manual" }))).toEqual({ action: "prompt" })
  })

  it("prompts even about a version they previously declined", () => {
    expect(decideUpdate(ctx({ trigger: "manual", declined: "1.18.41" }))).toEqual({
      action: "prompt",
    })
  })

  it("still reports nothing when there is genuinely nothing", () => {
    expect(decideUpdate(ctx({ trigger: "manual", available: undefined }))).toEqual({
      action: "none",
      reason: "no-update",
    })
  })
})

describe("no update", () => {
  it("never reports a phantom update, in any mode", () => {
    for (const mode of ["auto", "ask", "off"] as const) {
      expect(decideUpdate(ctx({ mode, available: undefined }))).toEqual({
        action: "none",
        reason: "no-update",
      })
    }
  })
})

describe("a silent install is already on disk", () => {
  it("does not re-download a version it already installed", () => {
    // check() keeps reporting the same version until IRIS restarts — it compares against the
    // RUNNING binary, which really is older. Without this the six-hourly timer re-downloads
    // the whole app bundle, every six hours, for as long as the app stays open.
    expect(decideUpdate(ctx({ mode: "auto", available: "1.18.41", installed: "1.18.41" }))).toEqual({
      action: "none",
      reason: "already-installed",
    })
  })

  it("still installs when a NEWER version appears", () => {
    expect(decideUpdate(ctx({ mode: "auto", available: "1.18.42", installed: "1.18.41" }))).toEqual({
      action: "install-silently",
    })
  })

  it("does not nag about a version already staged, even in ask mode", () => {
    expect(decideUpdate(ctx({ mode: "ask", available: "1.18.41", installed: "1.18.41" }))).toEqual({
      action: "none",
      reason: "already-installed",
    })
  })
})
