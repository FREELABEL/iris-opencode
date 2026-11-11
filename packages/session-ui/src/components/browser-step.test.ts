import { expect, test } from "bun:test"
import { browserStep } from "./browser-step"

test("browser steps read as plain words; typed text is never shown", () => {
  expect(browserStep({ action: "open", url: "https://www.perspiresaunastudio.com/locations" })).toBe("Opening perspiresaunastudio.com")
  expect(browserStep({ action: "screenshot", target: "panel" })).toBe("Looking at the page")
  expect(browserStep({ action: "type", ref: 3, text: "hunter2" })).toBe("Typing into a field")
  expect(browserStep({ action: "select", value: "Fort Worth: Hilton" })).toBe('Choosing "Fort Worth: Hilton"')
  expect(browserStep({ action: "scroll", direction: "up" })).toBe("Scrolling up")
})
