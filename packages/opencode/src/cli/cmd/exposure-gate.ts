/**
 * One gate for every command that can widen who may reach something.
 *
 * THE INVARIANT, and the only thing in this file that matters:
 *
 *     Widening always confirms. Narrowing never needs to.
 *
 * Those two directions are not symmetric and must never be given symmetric
 * friction. Narrowing is recoverable — the link starts 404ing, somebody says they
 * cannot get in, you widen it again, and nothing escaped. Widening cannot be taken
 * back at all: the moment a URL is fetched it can be cached, indexed, screenshotted
 * and forwarded, and making it private afterwards un-sends nothing.
 *
 * This file exists because five subsystems each grew their own answer to that and
 * all five got it wrong in the same direction — `genesis visibility` actually
 * confirmed when RESTRICTING and sailed through when going public. See epic #182344.
 *
 * NON-INTERACTIVE IS A REFUSAL, NOT A SKIP. The pre-existing pattern here was
 * `if (!args.yes && !isNonInteractive())` — no terminal, no prompt, proceed. That
 * makes an automated caller meet LESS friction than a person, which is exactly
 * backwards: the agent is the one who cannot see the consequence. Without a TTY we
 * refuse and name the flag.
 */

import * as prompts from "./clack"
import { isNonInteractive } from "./iris-api"

/** One ladder, every noun. Ordered least reachable → most. */
export const TIERS = ["private", "team", "gated", "unlisted", "public"] as const
export type Tier = (typeof TIERS)[number]

/**
 * The line that actually matters operationally sits between `gated` and `unlisted`:
 * above it a person is identified, below it the URL is the whole credential.
 */
export const FIRST_OPEN_TIER: Tier = "unlisted"

export function tierRank(t: Tier): number {
  const i = TIERS.indexOf(t)
  return i === -1 ? 0 : i
}

/** Is `to` reachable by someone who is never asked who they are? */
export function isOpen(t: Tier): boolean {
  return tierRank(t) >= tierRank(FIRST_OPEN_TIER)
}

/** Unknown `from` is treated as the most private thing it could be, so we err toward asking. */
export function isWidening(from: Tier | null | undefined, to: Tier): boolean {
  return tierRank(to) > tierRank(from ?? "private")
}

export interface WidenRequest {
  /** "page", "note", "playbook", "dataset feed", "component" — used in the prompt sentence. */
  noun: string
  /** slug, id or title. */
  name: string
  from?: Tier | null
  to: Tier
  /** What becomes reachable. Shown so the consequence is concrete, not abstract. */
  urls?: string[]
  /** Extra consequence lines — e.g. "4 pages render this component". */
  extra?: string[]
  /** Explicit consent. Required to widen without a TTY. */
  force?: boolean
  /** Legacy per-command flag (`--yes`) kept working as consent. */
  yes?: boolean
  /** Name of the flag to suggest when refusing. Defaults to "force". */
  forceFlag?: string
}

export type WidenVerdict =
  | { ok: true; prompted: boolean }
  | { ok: false; reason: "cancelled" | "needs-force" }

/**
 * Decide whether a widening may proceed. Returns rather than throwing so callers
 * can keep their own outro/exit-code conventions.
 *
 * Callers MUST treat `ok:false` as "do not perform the write".
 */
export async function confirmWiden(req: WidenRequest): Promise<WidenVerdict> {
  // Narrowing, or no change. Never ask. This is the half that must stay free.
  if (!isWidening(req.from, req.to)) return { ok: true, prompted: false }

  if (req.force || req.yes) return { ok: true, prompted: false }

  const lines = consequenceLines(req)

  if (isNonInteractive()) {
    prompts.log.error(
      `Refusing to widen ${req.noun} "${req.name}" to ${req.to.toUpperCase()} without a terminal.\n` +
        lines.map((l) => `  ${l}`).join("\n") +
        `\n\n  This is not undoable. Re-run with --${req.forceFlag ?? "force"} if that is what you intend.`,
    )
    return { ok: false, reason: "needs-force" }
  }

  prompts.log.warn(lines.join("\n"))
  const ok = await prompts.confirm({
    message: `Make ${req.noun} "${req.name}" ${req.to.toUpperCase()}?`,
  })
  if (prompts.isCancel(ok) || !ok) return { ok: false, reason: "cancelled" }
  return { ok: true, prompted: true }
}

/**
 * The consequence, in plain language. Exported so tests can assert on it and so a
 * caller can print it without running the gate.
 */
export function consequenceLines(req: WidenRequest): string[] {
  const out: string[] = []
  const from = req.from ?? "private"

  if (req.to === "public") {
    out.push(`This puts the ${req.noun} on the open internet — anyone at all, including crawlers.`)
  } else if (req.to === "unlisted") {
    out.push(`Anyone holding the link can read this ${req.noun}. It is not indexed, but it is NOT protected.`)
  } else {
    out.push(`This widens who can reach the ${req.noun}: ${from} → ${req.to}.`)
  }

  if (isOpen(req.to)) {
    out.push(`Once fetched it can be cached, indexed and forwarded. Making it private later does not un-send it.`)
  }

  for (const u of req.urls ?? []) out.push(`Becomes reachable: ${u}`)
  for (const e of req.extra ?? []) out.push(e)

  return out
}

/**
 * Blast radius for a change that is not about READING but about what a write
 * changes underneath other people — publishing a component overwrites the row and
 * every page naming it renders the new code immediately.
 *
 * Same invariant, different axis: a change with reach confirms; a change with none
 * does not.
 */
export interface OverwriteRequest {
  noun: string
  name: string
  /** How many other things immediately change. 0 means no confirmation is needed. */
  usageCount: number
  /** Names of the affected things, for the prompt. */
  usedBy?: string[]
  force?: boolean
  yes?: boolean
  forceFlag?: string
}

export async function confirmOverwrite(req: OverwriteRequest): Promise<WidenVerdict> {
  if (req.usageCount <= 0) return { ok: true, prompted: false }
  if (req.force || req.yes) return { ok: true, prompted: false }

  const who = (req.usedBy ?? []).slice(0, 8)
  const more = (req.usedBy?.length ?? 0) - who.length
  const body =
    `${req.usageCount} ${req.usageCount === 1 ? "page renders" : "pages render"} ${req.noun} "${req.name}".\n` +
    `They all change the moment this lands.` +
    (who.length ? `\n  ${who.join("\n  ")}` : "") +
    (more > 0 ? `\n  …and ${more} more` : "")

  if (isNonInteractive()) {
    prompts.log.error(
      `Refusing to overwrite ${req.noun} "${req.name}" without a terminal.\n  ${body.replace(/\n/g, "\n  ")}` +
        `\n\n  Re-run with --${req.forceFlag ?? "force"} if that is what you intend.`,
    )
    return { ok: false, reason: "needs-force" }
  }

  prompts.log.warn(body)
  const ok = await prompts.confirm({ message: `Overwrite ${req.noun} "${req.name}"?` })
  if (prompts.isCancel(ok) || !ok) return { ok: false, reason: "cancelled" }
  return { ok: true, prompted: true }
}
