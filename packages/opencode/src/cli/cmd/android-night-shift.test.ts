/**
 * The night shift (#191791) — a phone works a queue with nobody watching, so every rule here is
 * one that would otherwise fail silently at 3am.
 */
import { describe, expect, test } from "bun:test"
import { parseUiDump, checkExpect, datesOnScreen, timesOnScreen, findSendTargets, centerOf, isSendLabel } from "./android-screen"
import { parseBattery, parseLocked, parseAwake, healthVerdict } from "./android-health"
import {
  parseTasks, batchIdFor, parseUntil, newState, resume, nextTask, setResult, retryTask, dropTask, counts, needsYou, renderReport, TaskFileError,
} from "./android-batch"
import { routeFor } from "./kinetic-bodies"
import { decide, decideClass, type Couple } from "./kinetic-couple"
import { androidBody } from "./platform-android"

const node = (o: { text?: string; desc?: string; clickable?: boolean; bounds?: string; cls?: string }) =>
  `<node index="0" text="${o.text ?? ""}" resource-id="" class="${o.cls ?? "android.widget.TextView"}" content-desc="${o.desc ?? ""}" clickable="${o.clickable ? "true" : "false"}" enabled="true" bounds="${o.bounds ?? "[0,0][10,10]"}" />`

const dump = (...nodes: string[]) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${nodes.join("")}</hierarchy>UI hierchary dumped to: /dev/tty`

describe("the checker reads content, not just targets (#191798)", () => {
  /**
   * THE DEMO'S BEST MOMENT, AS A TEST THAT MUST KEEP FAILING THE BAD SEND. The agent was asked for
   * Nov 4 and typed Nov 14. If this ever passes, the night shift will send the wrong date.
   */
  test("a wrong date is caught, and the report says what the screen showed", () => {
    const screen = parseUiDump(dump(node({ text: "Reschedule appointment" }), node({ text: "Fri, Nov 14, 2026" }), node({ text: "2:00 PM" }), node({ text: "Confirm", clickable: true, bounds: "[100,1800][980,1900]" })))
    const r = checkExpect(screen, { date: "2026-11-04", time: "14:00" })
    expect(r.ok).toBe(false)
    expect(r.mismatches).toEqual([{ key: "date", expected: "2026-11-04", seen: ["2026-11-14"] }])
  })

  test("the right date passes in every way an app renders it", () => {
    for (const shown of ["2026-11-04", "11/4/2026", "11/04", "Nov 4", "Tue, Nov 4", "November 4th, 2026", "4 Nov 2026", "Nov. 4"]) {
      const r = checkExpect(parseUiDump(dump(node({ text: shown }))), { date: "2026-11-04" })
      expect(r.ok, shown).toBe(true)
    }
  })

  test("times are one value however they are written", () => {
    expect(timesOnScreen("2:00 PM")).toEqual(["14:00"])
    expect(timesOnScreen("2pm")).toEqual(["14:00"])
    expect(timesOnScreen("14:00")).toEqual(["14:00"])
    expect(timesOnScreen("12:30 a.m.")).toEqual(["00:30"])
    // FOUND BY THIS TEST: "2:00 PM" used to also yield 12:00, read from its "00 PM" — so a 2pm
    // booking passed a task that expected noon.
    expect(checkExpect(parseUiDump(dump(node({ text: "2:00 PM" }))), { time: "12:00" }).ok).toBe(false)
    expect(checkExpect(parseUiDump(dump(node({ text: "2:00 PM" }))), { time: "14:00" }).ok).toBe(true)
    expect(checkExpect(parseUiDump(dump(node({ text: "3:00 PM" }))), { time: "14:00" }).mismatches[0].seen).toEqual(["15:00"])
  })

  test("a plain value is a whole token — $85.03 is not satisfied by $185.03, and vice versa", () => {
    expect(checkExpect(parseUiDump(dump(node({ text: "Total $85.03" }))), { amount: "85.03" }).ok).toBe(true)
    expect(checkExpect(parseUiDump(dump(node({ text: "Total $185.03" }))), { amount: "85.03" }).ok).toBe(false)
    expect(checkExpect(parseUiDump(dump(node({ text: "Total $85.030" }))), { amount: "85.03" }).ok).toBe(false)
    expect(checkExpect(parseUiDump(dump(node({ text: "Pay $85.03." }))), { amount: "85.03" }).ok).toBe(true)
    expect(checkExpect(parseUiDump(dump(node({ desc: "To: Ops team" }))), { to: "ops team" }).ok).toBe(true)
  })

  test("an empty expect never passes — a checker that cannot fail is not a checker", () => {
    expect(checkExpect(parseUiDump(dump(node({ text: "anything" }))), {}).ok).toBe(false)
  })

  test("XML entities are decoded before comparing", () => {
    expect(parseUiDump(dump(node({ text: "Tom &amp; Jerry&apos;s" })))[0].text).toBe("Tom & Jerry's")
  })

  test("dates without a year take the expected year; slashes read US order", () => {
    expect(datesOnScreen("Nov 4", 2026)).toEqual(["2026-11-04"])
    expect(datesOnScreen("4/11", 2026)).toEqual(["2026-04-11"])
    expect(datesOnScreen("13/40", 2026)).toEqual([]) // not a date, not guessed into one
  })
})

describe("the send button is found, never guessed", () => {
  test("whole-label match — 'Send feedback' and 'Resend code' are not the commit button", () => {
    expect(isSendLabel("Confirm")).toBe(true)
    expect(isSendLabel(" pay now ")).toBe(true)
    expect(isSendLabel("Send feedback")).toBe(false)
    expect(isSendLabel("Resend code")).toBe(false)
  })

  test("a label on a TextView resolves to the clickable parent that contains it", () => {
    const nodes = parseUiDump(dump(
      node({ cls: "android.widget.FrameLayout", clickable: true, bounds: "[100,1800][980,1900]" }),
      node({ text: "Confirm", bounds: "[400,1830][680,1870]" }),
    ))
    const t = findSendTargets(nodes)
    expect(t).toHaveLength(1)
    expect(centerOf(t[0])).toEqual([540, 1850])
  })

  test("two send buttons are two targets — the batch holds rather than picking one", () => {
    const nodes = parseUiDump(dump(node({ text: "Send", clickable: true, bounds: "[0,0][10,10]" }), node({ text: "Post", clickable: true, bounds: "[20,0][30,10]" })))
    expect(findSendTargets(nodes)).toHaveLength(2)
  })
})

describe("phone health (#191799)", () => {
  const battery = (o: { level?: number; ac?: boolean; usb?: boolean; temp?: number }) =>
    `Current Battery Service state:\n  AC powered: ${o.ac ?? false}\n  USB powered: ${o.usb ?? false}\n  Wireless powered: false\n  status: 2\n  level: ${o.level ?? 80}\n  scale: 100\n  temperature: ${o.temp ?? 300}\n`

  test("parses dumpsys battery, with temperature in tenths of a degree", () => {
    expect(parseBattery(battery({ level: 19, usb: true, temp: 312 }))).toEqual({ level: 19, plugged: true, tempC: 31.2, status: "charging" })
  })

  test("low and plugged in is recovering, not dying — the demo started at 19%", () => {
    expect(healthVerdict({ battery: parseBattery(battery({ level: 19, usb: true })), locked: false, awake: true }).ok).toBe(true)
    const off = healthVerdict({ battery: parseBattery(battery({ level: 19 })), locked: false, awake: true })
    expect(off.ok).toBe(false)
    expect(off.reasons[0]).toContain("not charging")
  })

  test("heat and a lock screen both pause", () => {
    expect(healthVerdict({ battery: parseBattery(battery({ temp: 455, ac: true })), locked: false, awake: true }).reasons[0]).toContain("45.5")
    expect(healthVerdict({ battery: parseBattery(battery({ ac: true })), locked: true, awake: true }).ok).toBe(false)
  })

  test("unknown is not a reason to pause, and not a reason to claim health either", () => {
    expect(parseLocked("nothing here")).toBeNull()
    expect(parseAwake("")).toBeNull()
    expect(parseBattery("")).toEqual({ level: null, plugged: null, tempC: null, status: null })
    expect(healthVerdict({ battery: parseBattery(""), locked: null, awake: null }).ok).toBe(true)
  })

  test("lock field names across Android versions", () => {
    expect(parseLocked("  mShowingLockscreen=true mShowingDream=false")).toBe(true)
    expect(parseLocked("  isKeyguardShowing=false")).toBe(false)
    expect(parseAwake("  mWakefulness=Asleep")).toBe(false)
  })
})

describe("the batch (#191797)", () => {
  const NOW = new Date("2026-10-29T23:00:00")
  const tasks = parseTasks({
    tasks: [
      { id: "battery", prompt: "open Settings and read the battery level" },
      { id: "dentist", prompt: "move my appointment to Nov 4 at 2pm", send: true, expect: { date: "2026-11-04", time: "14:00" } },
      { id: "late", prompt: "anything" },
    ],
  })

  test("send without expect is refused at parse time, with every problem listed at once", () => {
    expect(() => parseTasks([{ id: "x", prompt: "pay it", send: true }, { id: "x", prompt: "" }])).toThrow(TaskFileError)
    try {
      parseTasks([{ id: "x", prompt: "pay it", send: true }, { id: "x", prompt: "" }])
    } catch (e: any) {
      expect(e.message).toContain("needs expect")
      expect(e.message).toContain("duplicate id")
      expect(e.message).toContain("prompt is empty")
    }
  })

  test("pro is the default profile, because pro is the one that checks its target", () => {
    expect(tasks[0].profile).toBe("pro")
  })

  test("a YAML date that decoded to a Date is compared as the date that was written", () => {
    expect(parseTasks([{ id: "d", prompt: "p", send: true, expect: { date: new Date("2026-11-04T00:00:00Z") } }])[0].expect.date).toBe("2026-11-04")
  })

  test("same file, same batch — a changed file is a new batch", () => {
    expect(batchIdFor("a")).toBe(batchIdFor("a"))
    expect(batchIdFor("a")).not.toBe(batchIdFor("a "))
  })

  test("--until 07:00 at 23:00 means tomorrow; a past ISO time is refused", () => {
    const u = parseUntil("07:00", NOW)
    expect(u.getDate()).toBe(30)
    expect(u.getHours()).toBe(7)
    expect(() => parseUntil("2026-10-01T00:00:00Z", NOW)).toThrow("already past")
    expect(() => parseUntil("breakfast", NOW)).toThrow()
  })

  test("a task left running is interrupted on resume — never silently re-run", () => {
    let s = newState({ batchId: "b1", file: "t.yaml", device: "x", until: parseUntil("07:00", NOW), tasks, now: NOW })
    s = setResult(s, "dentist", { status: "running" })
    s = resume(s)
    expect(s.tasks.dentist.status).toBe("interrupted")
    expect(needsYou(s)).toEqual(["dentist"])
    expect(nextTask(s, NOW).id).toBe("battery")
  })

  test("an explicit cutoff on resume replaces the old one — shortening it must work", () => {
    const s = newState({ batchId: "b1", file: "t.yaml", device: "x", until: new Date("2026-10-30T07:00:00"), tasks, now: NOW })
    expect(resume(s).until).toBe(s.until)
    expect(resume(s, new Date("2026-10-30T05:00:00")).until).toBe(new Date("2026-10-30T05:00:00").toISOString())
    expect(resume(s, new Date("2026-10-30T08:00:00")).until).toBe(new Date("2026-10-30T08:00:00").toISOString())
  })

  test("past the cutoff, everything pending expires and nothing runs", () => {
    let s = newState({ batchId: "b1", file: "t.yaml", device: "x", until: parseUntil("07:00", NOW), tasks, now: NOW })
    s = setResult(s, "battery", { status: "passed" })
    const r = nextTask(s, new Date("2026-10-30T07:00:01"))
    expect(r.id).toBeNull()
    expect(counts(r.state)).toMatchObject({ passed: 1, expired: 2 })
  })

  test("retry re-queues, drop removes; an unknown id is an error, not a no-op", () => {
    let s = newState({ batchId: "b1", file: "t.yaml", device: "x", until: parseUntil("07:00", NOW), tasks, now: NOW })
    s = setResult(s, "dentist", { status: "held", reason: "checker" })
    expect(retryTask(s, "dentist").tasks.dentist.status).toBe("pending")
    expect(dropTask(s, "dentist", NOW).tasks.dentist.status).toBe("dropped")
    expect(() => retryTask(s, "nope")).toThrow()
  })

  test("the report leads with what needs a person, and shows expected against seen", () => {
    let s = newState({ batchId: "b1", file: "t.yaml", device: "x", until: parseUntil("07:00", NOW), tasks, now: NOW })
    s = setResult(s, "battery", { status: "passed" })
    s = setResult(s, "dentist", { status: "held", reason: "checker refused the send", mismatches: [{ key: "date", expected: "2026-11-04", seen: ["2026-11-14"] }] })
    const md = renderReport(s, tasks)
    expect(md.indexOf("## Needs you")).toBeLessThan(md.indexOf("## Every task"))
    expect(md).toContain("expected `2026-11-04`, screen showed `2026-11-14`")
    expect(md).toContain("iris android batch retry b1 dentist")
  })
})

describe("the batch is behind the clutch before it touches the phone (S6)", () => {
  test("`android batch run` routes as an android run; status/retry/drop are reads", () => {
    expect(routeFor(["android", "batch", "run", "tasks.yaml"])).toMatchObject({ class: "android", verb: "run", instance: null })
    for (const sub of ["status", "retry", "drop", "report"]) expect(routeFor(["android", "batch", sub, "b1"])).toBeNull()
    expect(routeFor(["android", "night", "run", "tasks.yaml"]), "the alias is not a way round the door").toMatchObject({ class: "android", verb: "run" })
    expect(routeFor(["android", "health"])).toBeNull()
    expect(routeFor(["android", "check", "--expect", "date=2026-11-04"])).toBeNull()
  })
})

/**
 * FOUND WHILE BUILDING THIS. The act path named the body `phone:<serial>` while the class gate and
 * the body table said `android` — so no single couple passed both gates and every agent act on a
 * phone was refused. Failing closed hid it. One couple must satisfy BOTH questions.
 */
test("one android couple passes the class gate AND the instance gate the act path asks", () => {
  const HASH = "sha256:" + "c".repeat(64)
  const serial = "39081FDJH00ABC"
  const couple: Couple = { id: "cpl_n", agent: HASH, node: "studio", body: `android:${serial.toLowerCase()}`, allowlist: ["run", "tap"], policy: {}, created_at: "2026-10-29T00:00:00.000Z" }
  const base = { actor: { kind: "agent" as const, hash: HASH }, node: "studio", couples: [couple], now: "2026-10-29T23:00:00.000Z", enforceOperators: false, estimatedCents: null }
  expect(decideClass({ ...base, bodyClass: "android", verb: "run" } as any).decision).toBe("allow")
  expect(decide({ ...base, body: androidBody(serial), verb: "run" } as any).decision).toBe("allow")
  expect(decide({ ...base, body: androidBody(serial), verb: "tap" } as any).decision).toBe("allow")
  expect(decide({ ...base, body: androidBody(serial), verb: "type" } as any).decision, "a verb outside the allowlist").toBe("deny")
})
