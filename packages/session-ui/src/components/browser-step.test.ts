import { expect, test } from "bun:test"
import { browserStep, panelStep } from "./browser-step"

test("browser steps read as plain words; typed text is never shown", () => {
  expect(browserStep({ action: "open", url: "https://www.perspiresaunastudio.com/locations" })).toBe("Opening perspiresaunastudio.com")
  expect(browserStep({ action: "screenshot", target: "panel" })).toBe("Looking at the page")
  expect(browserStep({ action: "type", ref: 3, text: "hunter2" })).toBe("Typing into a field")
  expect(browserStep({ action: "select", value: "Fort Worth: Hilton" })).toBe('Choosing "Fort Worth: Hilton"')
  expect(browserStep({ action: "scroll", direction: "up" })).toBe("Scrolling up")
})

test("panel steps read as plain words", () => {
  expect(panelStep({ action: "show", surface: "browser" })).toBe("Showed Browser")
  expect(panelStep({ action: "show", surface: "atlas", sub: "artifacts" })).toBe("Showed Atlas › Artifacts")
  expect(panelStep({ action: "browse", url: "https://www.heb.com/cart" })).toBe("Opened heb.com in the Browser")
  expect(panelStep({ action: "card", bloq: 1, item: 193186 })).toBe("Opened card #193186")
  expect(panelStep({ action: "state" })).toBe("Checked what's on screen")
})
