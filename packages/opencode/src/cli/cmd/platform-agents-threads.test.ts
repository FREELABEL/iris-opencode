import { test, expect } from "bun:test"
import { buildThreadMessageBody } from "./platform-agents"

test("buildThreadMessageBody: plain user message omits agent + trigger fields", () => {
  expect(buildThreadMessageBody({ content: "hello" })).toEqual({ content: "hello" })
})

test("buildThreadMessageBody: as_agent_id is stringified when present", () => {
  expect(buildThreadMessageBody({ content: "hi", asAgentId: 679 })).toEqual({
    content: "hi",
    as_agent_id: "679",
  })
})

test("buildThreadMessageBody: null/blank as_agent_id is dropped", () => {
  expect(buildThreadMessageBody({ content: "hi", asAgentId: null })).toEqual({ content: "hi" })
  expect(buildThreadMessageBody({ content: "hi", asAgentId: "  " })).toEqual({ content: "hi" })
})

test("buildThreadMessageBody: trigger_responses only sent when suppressed", () => {
  // default (true) → omitted, server defaults to true
  expect(buildThreadMessageBody({ content: "x", asAgentId: 1, triggerResponses: true })).toEqual({
    content: "x",
    as_agent_id: "1",
  })
  // false → explicitly sent
  expect(buildThreadMessageBody({ content: "x", asAgentId: 1, triggerResponses: false })).toEqual({
    content: "x",
    as_agent_id: "1",
    trigger_responses: false,
  })
})
