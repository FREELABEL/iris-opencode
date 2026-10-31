export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"
import * as WalkPolicy from "./ripgrep/walk-policy"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
/**
 * Wall-clock budgets (#191073). A result cap alone never stops a walk whose pattern matches
 * little: `**\/.git` from `/` ran 9+ minutes. When the budget runs out the walk is killed and
 * what it found so far is returned, with onCutoff telling the caller it was cut short.
 */
export const LIST_BUDGET_MS = 20_000
export const GREP_BUDGET_MS = 30_000
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  /** Wall-clock budget in ms. Defaults to LIST_BUDGET_MS / GREP_BUDGET_MS. */
  readonly budgetMs?: number
  /** Called when the walk was stopped by its budget; the results returned are partial. */
  readonly onCutoff?: (info: Cutoff) => void
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  /** Wall-clock budget in ms. Defaults to LIST_BUDGET_MS / GREP_BUDGET_MS. */
  readonly budgetMs?: number
  /** Called when the walk was stopped by its budget; the results returned are partial. */
  readonly onCutoff?: (info: Cutoff) => void
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
  /** Wall-clock budget in ms. Defaults to LIST_BUDGET_MS / GREP_BUDGET_MS. */
  readonly budgetMs?: number
  /** Called when the walk was stopped by its budget; the results returned are partial. */
  readonly onCutoff?: (info: Cutoff) => void
}

export interface Cutoff {
  readonly reason: "time"
  readonly elapsedMs: number
  readonly found: number
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

/** Does a glob pattern name a `.git` directory or something inside one? */
export const targetsGit = (pattern: string) => /(^|\/)\.git(\/|$)/u.test(pattern)

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
      readonly budgetMs: number
      readonly onCutoff?: (info: Cutoff) => void
      /** false for a single named file: nothing is walked, so there is nothing to bound. */
      readonly walks: boolean
    }) => {
      const walk = WalkPolicy.scope(input.cwd)
      if (input.walks && walk.refuse) return Effect.fail(failure(walk.refuse))
      // Prune protected folders. They must come LAST among the globs (see withExcludes).
      const args = input.walks ? WalkPolicy.withExcludes(input.args, walk.excludes) : input.args
      const collected: A[] = []
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              // Kept outside the scope so a walk stopped by its budget still returns what it found.
              collected.push(row)
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runDrain,
          )
          const rows = collected
          const truncated = rows.length > input.limit
          if (truncated) return { items: rows.slice(0, input.limit), truncated, partial: false }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return { items: code === 1 ? [] : rows, truncated: false, partial: code === 2 }
        }),
      )
      const started = Date.now()
      const budgeted = Effect.timeoutOrElse(program, {
        duration: input.budgetMs,
        orElse: () =>
          Effect.sync(() => {
            const items = collected.slice(0, input.limit)
            input.onCutoff?.({ reason: "time", elapsedMs: Date.now() - started, found: items.length })
            return { items, truncated: false, partial: true }
          }),
      })
      const abortable = input.signal ? budgeted.pipe(Effect.raceFirst(waitForAbort(input.signal))) : budgeted
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          budgetMs: input.budgetMs ?? LIST_BUDGET_MS,
          onCutoff: input.onCutoff,
          walks: true,
          args: [
            "--no-config",
            "--files",
            // A pattern that names .git (e.g. **/.git/HEAD, how to find repositories) must be
            // able to see it: .git is hidden, and `!**/.git/**` hid even its top-level files.
            ...(input.hidden || targetsGit(input.pattern) ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            targetsGit(input.pattern) ? "--glob=!**/.git/*/**" : "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          budgetMs: input.budgetMs ?? LIST_BUDGET_MS,
          onCutoff: input.onCutoff,
          walks: true,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          budgetMs: input.budgetMs ?? GREP_BUDGET_MS,
          walks: input.file === undefined,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES
              ? Effect.fail(failure(`Ripgrep JSON record exceeded ${MAX_RECORD_BYTES} bytes`))
              : Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: (cause) => failure("Invalid ripgrep JSON output", cause),
                })
            ).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text:
                  match.lines.text.length > 2_000
                    ? match.lines.text.slice(0, 2_000).replace(/[\uD800-\uDBFF]$/, "") + "..."
                    : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
