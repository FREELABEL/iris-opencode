import { describe, expect, test } from "bun:test"
import { repairToolName } from "./tool-name-repair"

const tools = ["IRIS_OS_iris_help", "IRIS_OS_iris_run", "atlas_search", "bash", "read", "invalid"]

describe("repairToolName (#189837)", () => {
  test("a doubled segment maps to the tool the model meant", () => {
    expect(repairToolName("IRIS_OS_iris_iris_help", tools)).toBe("IRIS_OS_iris_help")
  })
  test("case alone is repaired", () => {
    expect(repairToolName("Bash", tools)).toBe("bash")
  })
  test("an unknown tool stays unknown", () => {
    expect(repairToolName("IRIS_OS_iris_delete_everything", tools)).toBeNull()
  })
  test("ambiguity is never guessed", () => {
    expect(repairToolName("iris_help", ["a_iris_help", "b_iris_help"].map((x) => x))).toBeNull()
    expect(repairToolName("x_x_y", ["x_y", "X_Y"])).toBeNull()
  })
  test("never maps onto invalid", () => {
    expect(repairToolName("Invalid", ["invalid"])).toBeNull()
  })
})
