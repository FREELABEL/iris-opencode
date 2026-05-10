// Quiet-safe re-export of @clack/prompts.
// In non-TTY contexts (piped stdin/stdout, e.g. inside TUI bash tool),
// ANSI spinners and decorations are suppressed so only plain text survives.
import * as _prompts from "@clack/prompts"

const _quiet = !process.stdout.isTTY
const _noop = (() => {}) as (...args: any[]) => any
const _noopSpinner = { start: _noop, stop: _noop, message: _noop }

export const intro = _quiet ? _noop : _prompts.intro
export const outro = _quiet ? _noop : _prompts.outro
export const spinner = _quiet ? (() => _noopSpinner) as typeof _prompts.spinner : _prompts.spinner
export const log = _quiet
  ? ({ info: _noop, warn: _noop, error: _noop, success: _noop, step: _noop, message: _noop } as typeof _prompts.log)
  : _prompts.log

// Pass through everything else unchanged
export const text = _prompts.text
export const confirm = _prompts.confirm
export const select = _prompts.select
export const multiselect = _prompts.multiselect
export const isCancel = _prompts.isCancel
export const cancel = _prompts.cancel
export const group = _prompts.group
export const note = _prompts.note
export const password = _prompts.password
export const autocomplete = _prompts.autocomplete
