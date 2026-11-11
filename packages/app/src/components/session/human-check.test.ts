import { describe, expect, test } from "bun:test"
import { HUMAN_CHECK_SCRIPT, HUMAN_CHECK_WAIT, humanCheckShowing, isHumanCheck, type HumanCheckSignals } from "./human-check"

const page = (s: Partial<HumanCheckSignals>): HumanCheckSignals => ({
  title: "",
  heading: "",
  cfChallenge: false,
  blockWidget: false,
  asksForHuman: false,
  ...s,
})

describe("human check", () => {
  test("Cloudflare, Indeed's block page, DataDome and PerimeterX are checks", () => {
    expect(isHumanCheck(page({ title: "Just a moment..." }))).toBe(true)
    expect(isHumanCheck(page({ title: "indeed.com", heading: "Additional Verification Required" }))).toBe(true)
    expect(isHumanCheck(page({ title: "Attention Required! | Cloudflare" }))).toBe(true)
    expect(isHumanCheck(page({ cfChallenge: true }))).toBe(true)
    expect(isHumanCheck(page({ blockWidget: true }))).toBe(true)
    expect(isHumanCheck(page({ title: "heb.com", asksForHuman: true }))).toBe(true)
  })

  test("ordinary pages are not, even ones that mention captchas", () => {
    expect(isHumanCheck(page({ title: "Job Search | Indeed", heading: "What job are you looking for?" }))).toBe(false)
    expect(isHumanCheck(page({ title: "How to verify you are human: a CAPTCHA history", heading: "CAPTCHAs explained" }))).toBe(false)
    expect(isHumanCheck(null)).toBe(false)
  })

  test("asks the page with one read-only script and treats any failure as no check", async () => {
    let script = ""
    const yes = await humanCheckShowing(async (s) => {
      script = s
      return JSON.stringify({ ok: true, value: page({ title: "Just a moment..." }) })
    })
    expect(yes).toBe(true)
    expect(script).toBe(HUMAN_CHECK_SCRIPT)
    expect(await humanCheckShowing(async () => JSON.stringify({ ok: false, error: "no page" }))).toBe(false)
    expect(await humanCheckShowing(async () => Promise.reject(new Error("pane gone")))).toBe(false)
  })

  test("the script runs in a real page and reads the signals", () => {
    document.title = "Just a moment..."
    document.body.innerHTML = "<h1>Verify you are human</h1><p>Press and hold</p>"
    const v = (0, eval)(HUMAN_CHECK_SCRIPT) as HumanCheckSignals
    expect(v.title).toBe("Just a moment...")
    expect(v.heading).toBe("Verify you are human")
    expect(isHumanCheck(v)).toBe(true)
  })

  test("the waiting answer is the text the engine waits on (panel-page.ts WAITING_FOR_ALLOW)", () => {
    expect(/click Allow in the Browser bar|finish the check in the Browser/.test(HUMAN_CHECK_WAIT)).toBe(true)
  })
})
