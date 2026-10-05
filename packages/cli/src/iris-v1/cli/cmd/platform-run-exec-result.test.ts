import { describe, expect, test } from "bun:test"
import { isFailedResult, isUnknownFunctionError, knownFunctionsFor } from "./platform-run"

// `iris integrations exec` exits 1 exactly when isFailedResult() is true. It used to exit 0
// on `success: false`, so an agent could not tell a failed call from a result.
describe("isFailedResult", () => {
  test("success:false is a failure", () => {
    expect(isFailedResult({ success: false, error: "Tool GOOGLEDRIVE_X not found" })).toBe(true)
  })
  test("success:false with no error text is still a failure", () => {
    // Isolates the success flag — with an error field present the other branch also fires.
    expect(isFailedResult({ success: false })).toBe(true)
    expect(isFailedResult({ success: false, error: "" })).toBe(true)
  })
  test("an error with no success flag is a failure", () => {
    expect(isFailedResult({ error: "boom" })).toBe(true)
  })
  test("no result at all is a failure", () => {
    expect(isFailedResult(null)).toBe(true)
    expect(isFailedResult(undefined)).toBe(true)
  })
  test("success:true wins even if an error field rides along", () => {
    expect(isFailedResult({ success: true, error: null, data: { files: [] } })).toBe(false)
    expect(isFailedResult({ success: true, error: "partial" })).toBe(false)
  })
  test("a plain payload without flags is a result", () => {
    expect(isFailedResult({ files: [] })).toBe(false)
    expect(isFailedResult([])).toBe(false)
  })
})

describe("isUnknownFunctionError", () => {
  test("recognises the Composio 404 a guessed name produces", () => {
    const composio =
      'Composio action failed: {"message":"Tool GOOGLEDRIVE_LIST_FOLDER_CHILDREN not found","code":2401,"slug":"Tool_ToolNotFound","status":404}'
    expect(isUnknownFunctionError({ success: false, error: composio })).toBe(true)
  })
  test("does not fire on a parameter error for a real function", () => {
    const missing = "Composio GOOGLEDRIVE_GET_FILE_METADATA failed: Invalid request data provided - Following fields are missing: {'fileId'}"
    expect(isUnknownFunctionError({ success: false, error: missing })).toBe(false)
  })
})

describe("knownFunctionsFor google-drive", () => {
  test("advertises the folder-capable functions, with their parameters", () => {
    const names = (knownFunctionsFor("google-drive") ?? []).map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(["search_files", "list_files", "list_shared_drives", "get_file_info"]))
    const search = knownFunctionsFor("google-drive")!.find((f) => f.name === "search_files")!
    expect(search.description).toContain("mime_type")
  })
})
