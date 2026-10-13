import { describe, expect, test } from "bun:test"
import { clearIrisNav, clearIrisPanelOpen, irisNavRequest, irisPanelOpenRequest, openIrisPanel } from "./iris-nav"
import { hivePillTarget } from "./iris-hive-inbox-model"

describe("openIrisPanel (#189279)", () => {
  test("asks for the panel to open AND for the pane — a pill click needs both", () => {
    clearIrisNav()
    clearIrisPanelOpen()
    openIrisPanel(hivePillTarget("inbox"))
    // Only the pane: the panel stays shut and the click looks dead. Only the panel: it opens on
    // whatever surface was last used. That second one was the bug Alex hit.
    expect(irisPanelOpenRequest()).not.toBeNull()
    expect(irisNavRequest()).toMatchObject({ surface: "hive", sub: "inbox" })
    clearIrisNav()
    clearIrisPanelOpen()
  })

  test("the Hive pill lands on Machines", () => {
    openIrisPanel(hivePillTarget("machines"))
    expect(irisNavRequest()).toMatchObject({ surface: "hive", sub: "machines" })
    clearIrisNav()
    clearIrisPanelOpen()
  })
})
