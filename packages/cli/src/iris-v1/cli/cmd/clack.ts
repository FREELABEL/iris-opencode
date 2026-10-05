// Quiet-safe re-export of @clack/prompts.
// In non-TTY contexts (piped stdin/stdout, e.g. inside TUI bash tool),
// ANSI spinners and decorations are suppressed so only plain text survives.
import * as _prompts from "@clack/prompts"

const _quiet = !process.stdout.isTTY
const _noop = (() => {}) as (...args: any[]) => any

// In non-TTY (MCP, piped), output plain text to stderr so callers still see messages
const _plainLog = (msg: string) => { if (msg) process.stderr.write(String(msg) + "\n") }
const _plainSpinner = {
  start: (msg?: string) => { if (msg) _plainLog(msg) },
  stop: (msg?: string, _code?: number) => { if (msg) _plainLog(msg) },
  message: (msg?: string) => { if (msg) _plainLog(msg) },
}

export const intro = _quiet ? ((title?: string) => { if (title) _plainLog(String(title)) }) as typeof _prompts.intro : _prompts.intro
export const outro = _quiet ? ((msg?: string) => { if (msg) _plainLog(String(msg)) }) as typeof _prompts.outro : _prompts.outro
export const spinner = _quiet ? (() => _plainSpinner) as unknown as typeof _prompts.spinner : _prompts.spinner
export const log = _quiet
  ? ({ info: _plainLog, warn: _plainLog, error: _plainLog, success: _plainLog, step: _plainLog, message: _plainLog } as typeof _prompts.log)
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
