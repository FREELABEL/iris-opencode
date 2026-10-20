import { createRoot, createSignal } from "solid-js"

/**
 * The server REFUSED a message for the IRIS allowance (session status retry, reason
 * iris_budget_exceeded). The API is the gate; this is how the composer hears about it, so the
 * allowance tab can open itself with the upgrade instead of a modal (Alex, 2026-10-20).
 * A counter, not a boolean: every refusal is a new event, even the same one twice.
 */
const [refusal, setRefusal] = createRoot(() => createSignal<{ count: number; resetsAt?: string } | undefined>())

export const allowanceRefusal = refusal

export function markAllowanceRefused(resetsAt?: string) {
  setRefusal((prev) => ({ count: (prev?.count ?? 0) + 1, resetsAt }))
}
