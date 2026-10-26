/**
 * What the send button is showing (#190993 follow-up). The look follows it: "idle" is quiet and
 * not clickable, "ready" is bright with a pointer and hover, "stop" is bright and stops the reply.
 */
export type SubmitState = "idle" | "ready" | "stop"

export function submitState(input: { stopping: boolean; disabled: boolean }): SubmitState {
  if (input.stopping) return "stop"
  return input.disabled ? "idle" : "ready"
}
