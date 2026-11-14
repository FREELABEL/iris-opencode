/**
 * Vault copies that look after themselves (#193363, follow-up to PR #572).
 *
 *   1. CATCH-UP ON PLUG-IN. The IRIS daemon on each machine notices a drive being connected and
 *      runs `iris vault auto run` (the same work as `iris vault sync`) for the vault copies on it.
 *      This file holds the parts that decide: is auto catch-up on (this machine, this vault), is a
 *      sync of this vault already running (a lock), and the one-line status written afterwards
 *      ("caught up 3 files, 2 min ago").
 *
 *   2. SELF-HEALING. A copy nobody has verified for `lost_after_days` (default 14) is LOST, and is
 *      rebuilt — encrypted chunks only, each one hash-checked — on a SPARE the user named for that
 *      vault. Never anywhere else: planHeal only ever proposes a spare from the vault's own list,
 *      and assertSpare refuses any other target right before a write. No spare reachable with room
 *      = an alert, nothing written.
 *
 * ── THE DEFAULT POLICY (configurable per vault: iris vault policy <v>) ─────────────────────
 *
 *   lost after     14 days unseen               --lost-after 14d   (h / d / w)
 *   rebuilt on     the vault's spares, in the order the user listed them; nothing else, ever
 *   no spare       alert only (iris vault status, iris drives list, the drive's Atlas record)
 *   lost returns   KEEP BOTH copies              --on-return keep|retire
 *
 * Why keep both by default: retiring deletes a verified copy, which is the one irreversible step in
 * this whole feature, and the copy it would trust instead belongs to a drive that has just gone
 * missing for two weeks. A spare holds ciphertext of a vault its owner already set space aside
 * for, so keeping it costs space the user chose to give; deleting it on a guess can cost the data.
 * With `retire`, the spare's copy is deleted only after the returned copy is verified complete at
 * the current manifest — and only where IRIS can reach it to delete it.
 *
 * Pure apart from the lock and the small per-machine config file. No network.
 */

import fs from "fs"
import path from "path"
import os from "os"
import { VaultUserError } from "./encrypted-vault-files"
import { targetKey, type VaultTarget, type ReplicaIndex } from "./vault-drives"

// ── policy ─────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_LOST_AFTER_DAYS = 14
export type OnReturn = "keep" | "retire"
export const DEFAULT_ON_RETURN: OnReturn = "keep"

/** A spare that holds a rebuilt copy. Lives in the vault's meta AND on its row in the catalog. */
export type Healed = {
  /** target key of the spare that now holds a copy */
  spare: string
  /** target key of the copy it stands in for */
  replaces: string
  at: string
  /** the lost copy was verified again (policy keep: both count) */
  returned_at?: string | null
  /** the spare's copy was deleted after the lost one returned (policy retire) */
  retired_at?: string | null
}

export type PolicyFields = {
  spares?: VaultTarget[]
  lost_after_days?: number
  on_return?: OnReturn
  /** false = never caught up automatically (manual iris vault sync still works) */
  auto?: boolean
  healed?: Healed[]
  /** when the policy or the list of places last changed — the newest copy of vault.json wins */
  updated_at?: string
}

export type VaultPolicy = { lost_after_days: number; on_return: OnReturn; auto: boolean; spares: VaultTarget[] }

export function policyOf(m: PolicyFields): VaultPolicy {
  const d = Number(m.lost_after_days)
  return {
    lost_after_days: Number.isFinite(d) && d > 0 ? d : DEFAULT_LOST_AFTER_DAYS,
    on_return: m.on_return === "retire" ? "retire" : DEFAULT_ON_RETURN,
    auto: m.auto !== false,
    spares: m.spares ?? [],
  }
}

/**
 * "14d" / "36h" / "2w" / "14" (days) / "30m" → days. At most ten years. Minutes exist for trying the
 * heal out on throwaway drives; at least one minute.
 */
export function parseLostAfter(s: unknown): number {
  const m = String(s ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)?$/)
  if (!m) throw new VaultUserError(`--lost-after takes a duration like 14d, 36h or 2w (got "${s}")`)
  const n = Number(m[1])
  const days = m[2] === "m" ? n / 1440 : m[2] === "h" ? n / 24 : m[2] === "w" ? n * 7 : n
  if (!(days >= 1 / 1440 - 1e-12)) throw new VaultUserError("--lost-after must be at least 1m")
  if (days > 3650) throw new VaultUserError("--lost-after must be at most 3650d")
  return days
}

/** "unseen 16 days" / "unseen 3 h" / "unseen 4 min" / "never seen". */
export function unseenText(ms: number): string {
  if (!(ms >= 0)) return "never seen"
  if (ms >= 86_400_000) { const d = Math.floor(ms / 86_400_000); return `unseen ${d} day${d === 1 ? "" : "s"}` }
  if (ms >= 3_600_000) return `unseen ${Math.floor(ms / 3_600_000)} h`
  return `unseen ${Math.max(1, Math.floor(ms / 60_000))} min`
}

export function fmtDays(days: number): string {
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`
  if (days < 1) return `${Math.round(days * 24 * 100) / 100}h`
  if (days % 7 === 0 && days >= 14) return `${days / 7}w`
  return `${Math.round(days * 100) / 100}d`
}

export function parseOnReturn(s: unknown): OnReturn {
  const v = String(s ?? "").trim().toLowerCase()
  if (v === "keep" || v === "retire") return v
  throw new VaultUserError(`--on-return is keep (both copies stay) or retire (the spare's copy is deleted once the lost one is verified again) — got "${s}"`)
}

// ── spares: named by the user, never inferred ──────────────────────────────────────────────

/**
 * Add spares. A spare must be a place the vault does NOT already copy to (it would add nothing)
 * and is listed once. Order is kept: it is the order spares are tried in.
 */
export function addSpares(current: VaultTarget[], add: VaultTarget[], copies: VaultTarget[]): VaultTarget[] {
  const out = [...current]
  const copyKeys = new Set(copies.map(targetKey))
  for (const t of add) {
    const k = targetKey(t)
    if (copyKeys.has(k)) throw new VaultUserError(`${label(t)} already holds a copy of this vault — a spare is a place that does not`)
    if (out.some((x) => targetKey(x) === k)) continue
    out.push(t)
  }
  return out
}

export function removeSpare(current: VaultTarget[], key: string, healed: Healed[] = []): VaultTarget[] {
  if (!current.some((t) => targetKey(t) === key)) throw new VaultUserError(`${key.replace(/^(drive|machine):/, "")} is not a spare of this vault`)
  if (activeHealed(healed).some((h) => h.spare === key)) {
    throw new VaultUserError(`${key.replace(/^(drive|machine):/, "")} holds a rebuilt copy right now — it stays a spare until that copy is retired (iris vault policy <vault> --on-return retire, then plug the lost copy back in)`)
  }
  return current.filter((t) => targetKey(t) !== key)
}

/** The guard in front of every heal write: the target must be one of THIS vault's named spares. */
export function assertSpare(spares: readonly VaultTarget[], key: string): VaultTarget {
  const t = spares.find((s) => targetKey(s) === key)
  if (!t) throw new VaultUserError(`refusing to rebuild a copy on ${key}: it is not a spare you named for this vault (iris vault spare add <vault> <drive or machine>)`)
  return t
}

const label = (t: VaultTarget) => (t.kind === "drive" ? t.label : t.name)

export const activeHealed = (h: readonly Healed[] = []) => h.filter((x) => !x.retired_at)

/** The catalog knows about heals done on other machines; merge them into this machine's view. */
export function mergeHealed(local: readonly Healed[] = [], rows: ReadonlyArray<Record<string, any>>, vaultId: string): Healed[] {
  const by = new Map<string, Healed>()
  for (const h of local) by.set(h.spare, { ...h })
  for (const r of rows) {
    if (r.vault_id !== vaultId || (r.role !== "spare" && r.role !== "spare-retired") || !r.replaces) continue
    const cur = by.get(String(r.target))
    const fromRow: Healed = {
      spare: String(r.target), replaces: String(r.replaces), at: String(r.healed_at ?? ""),
      returned_at: r.returned_at || null, retired_at: r.retired_at || null,
    }
    // The newest heal of a spare wins (a spare can be used again after a retire); for the same heal,
    // a return or retire recorded on either side sticks.
    if (!cur || fromRow.at > cur.at) by.set(fromRow.spare, fromRow)
    else if (fromRow.at === cur.at) {
      by.set(fromRow.spare, { ...cur, returned_at: cur.returned_at || fromRow.returned_at || null, retired_at: cur.retired_at || fromRow.retired_at || null })
    }
  }
  return [...by.values()].sort((a, b) => (a.spare < b.spare ? -1 : 1))
}

// ── lost, and the plan to heal ─────────────────────────────────────────────────────────────

type Row = Record<string, any>

/** When a copy was last verified (any machine), else its baseline (vault created / spare filled). */
export function lastSeen(key: string, rows: readonly Row[], vaultId: string, baseline: string | null): number {
  let best = NaN
  for (const r of rows) {
    if (r.vault_id !== vaultId || r.target !== key || !r.last_verified_at) continue
    const t = Date.parse(String(r.last_verified_at))
    if (Number.isFinite(t) && !(t <= best)) best = t
  }
  if (Number.isFinite(best)) return best
  const b = baseline ? Date.parse(baseline) : NaN
  return Number.isFinite(b) ? b : NaN
}

export type Reach = { ok: true } | { ok: false; why: string }

export type HealPlan = {
  /** copies unseen longer than lost_after_days */
  lost: Array<{ key: string; days: number; /** unseen for this long, -1 = never seen */ ms: number }>
  /** rebuild `replaces` on `spare` */
  rebuild: Array<{ replaces: string; spare: string }>
  /** lost, and no spare could take it: alert only */
  alerts: Array<{ replaces: string; why: string }>
  /** a lost copy that is back while its spare still holds a copy */
  returned: Array<{ key: string; spare: string }>
  /** spare copies to delete (policy retire, the returned copy verified complete at the current seq) */
  retire: Array<{ spare: string; replaces: string }>
}

/**
 * Decide, from the catalog, which copies are lost and where each is rebuilt. `copies` is every place
 * the vault names (its --on list and the machine it was made on); `liveOk` are the copies verified
 * complete in this very run. `reach` is asked only about the vault's own spares.
 */
export function planHeal(o: {
  vaultId: string
  createdAt: string
  copies: VaultTarget[]
  policy: VaultPolicy
  healed: Healed[]
  rows: readonly Row[]
  now: Date
  seq: number
  liveOk?: ReadonlySet<string>
  reach: (spare: VaultTarget) => Reach
}): HealPlan {
  const plan: HealPlan = { lost: [], rebuild: [], alerts: [], returned: [], retire: [] }
  const limit = o.policy.lost_after_days * 86_400_000
  const live = o.liveOk ?? new Set<string>()
  const active = activeHealed(o.healed)
  const baseline = (k: string) => active.find((h) => h.spare === k)?.at ?? o.createdAt
  const isLost = (k: string) => {
    if (live.has(k)) return false
    const seen = lastSeen(k, o.rows, o.vaultId, baseline(k))
    const lost = !Number.isFinite(seen) || o.now.getTime() - seen > limit
    const ms = Number.isFinite(seen) ? o.now.getTime() - seen : -1
    if (lost) plan.lost.push({ key: k, days: ms >= 0 ? Math.floor(ms / 86_400_000) : -1, ms })
    return lost
  }
  const placeKeys = [...new Set([...o.copies.map(targetKey), ...active.map((h) => h.spare)])]
  const lostSet = new Set(placeKeys.filter(isLost))

  // A lost copy that came back: verified complete at the current manifest, recently.
  const completeNow = (k: string) =>
    live.has(k) ||
    o.rows.some((r) => r.vault_id === o.vaultId && r.target === k && r.status === "ok" && Number(r.manifest_seq ?? 0) >= o.seq && !lostSet.has(k))
  for (const h of active) {
    if (lostSet.has(h.replaces) || !completeNow(h.replaces)) continue
    plan.returned.push({ key: h.replaces, spare: h.spare })
    if (o.policy.on_return === "retire") plan.retire.push({ spare: h.spare, replaces: h.replaces })
  }

  // Each lost copy not already stood in for by a healthy spare needs one.
  const covered = (k: string) => active.some((h) => h.replaces === k && !lostSet.has(h.spare))
  const needs = placeKeys.filter((k) => lostSet.has(k) && !covered(k))
  const busy = new Set(placeKeys)
  const tried = new Map<string, string>()
  for (const k of needs) {
    let chosen: string | null = null
    for (const s of o.policy.spares) {
      const sk = targetKey(s)
      if (busy.has(sk)) continue
      const r = o.reach(s)
      if (!r.ok) { tried.set(sk, r.why); continue }
      chosen = sk
      break
    }
    if (chosen) {
      busy.add(chosen)
      plan.rebuild.push({ replaces: k, spare: chosen })
      continue
    }
    const why = !o.policy.spares.length
      ? "no spare named for this vault — add one: iris vault spare add <vault> <drive or machine>"
      : "no spare can take it now: " + o.policy.spares.map((s) => `${label(s)} ${busy.has(targetKey(s)) ? "already holds a copy" : tried.get(targetKey(s)) ?? "not tried"}`).join("; ")
    plan.alerts.push({ replaces: k, why })
  }
  return plan
}

// ── auto catch-up: on/off per machine and per vault ────────────────────────────────────────

export type AutoState = {
  /** this machine: catch up automatically when a drive is plugged in (default on) */
  enabled: boolean
  updated_at?: string
  /** last catch-up per vault id, shown by iris vault auto status */
  last?: Record<string, { at: string; text: string; trigger?: string }>
  /** last heal per vault id */
  last_heal?: Record<string, { at: string; text: string }>
}

export const autoFile = (home = os.homedir()) => path.join(home, ".iris", "vault-auto.json")

export function readAuto(file = autoFile()): AutoState {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    return { ...j, enabled: j?.enabled !== false }
  } catch {
    return { enabled: true }
  }
}

export function writeAuto(s: AutoState, file = autoFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Why an automatic catch-up of this vault does not run here, or null when it may. */
export function autoBlocked(machine: AutoState, vault: PolicyFields): string | null {
  if (!machine.enabled) return "automatic catch-up is off on this machine (turn on: iris vault auto on)"
  if (vault.auto === false) return "automatic catch-up is off for this vault (turn on: iris vault auto on <vault>)"
  return null
}

// ── one sync per vault at a time ───────────────────────────────────────────────────────────

export const lockDir = (home = os.homedir()) => path.join(home, ".iris", "vault-locks")

export type Lock = { ok: true; release: () => void } | { ok: false; holder: string }

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

/**
 * An exclusive lock file per vault (O_EXCL create). A lock whose process is gone, or older than
 * `staleMs` (default 6 h — a sync of a big drive is long, but not that long), is taken over.
 */
export function acquireLock(vaultId: string, o: { dir?: string; pid?: number; now?: number; staleMs?: number; what?: string; isAlive?: (pid: number) => boolean } = {}): Lock {
  const dir = o.dir ?? lockDir()
  const pid = o.pid ?? process.pid
  const now = o.now ?? Date.now()
  const stale = o.staleMs ?? 6 * 3_600_000
  const isAlive = o.isAlive ?? alive
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${vaultId.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600)
      fs.writeSync(fd, JSON.stringify({ pid, at: new Date(now).toISOString(), what: o.what ?? "sync" }))
      fs.closeSync(fd)
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          try {
            const cur = JSON.parse(fs.readFileSync(file, "utf8"))
            if (cur?.pid === pid) fs.rmSync(file, { force: true })
          } catch { /* already gone */ }
        },
      }
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e
      let cur: any = null
      try { cur = JSON.parse(fs.readFileSync(file, "utf8")) } catch { /* half-written: treat by age */ }
      const at = cur?.at ? Date.parse(cur.at) : fs.statSync(file).mtimeMs
      const dead = cur?.pid ? !isAlive(Number(cur.pid)) : false
      if (attempt === 0 && (dead || now - at > stale)) {
        fs.rmSync(file, { force: true })
        continue
      }
      return { ok: false, holder: cur ? `${cur.what ?? "sync"} by process ${cur.pid} since ${cur.at}` : "another process" }
    }
  }
  return { ok: false, holder: "another process" }
}

// ── the status line ────────────────────────────────────────────────────────────────────────

/** Files (contents) that got at least one chunk in this catch-up. */
export function filesTouched(index: Pick<ReplicaIndex, "content">, written: Iterable<string>): number {
  const w = new Set(written)
  if (!w.size) return 0
  return index.content.filter((c) => c.chunks.some((id) => w.has(id))).length
}

export function catchupText(files: number, chunks: number, from?: string[]): string {
  if (!chunks) return "up to date"
  return `caught up ${files} file${files === 1 ? "" : "s"} (${chunks} chunk${chunks === 1 ? "" : "s"})${from?.length ? ` from ${from.join(", ")}` : ""}`
}

/** "just now" / "2 min ago" / "3 h ago" / "5 days ago". */
export function ago(at: string | number | null | undefined, now: Date = new Date()): string {
  const t = typeof at === "number" ? at : at ? Date.parse(String(at)) : NaN
  if (!Number.isFinite(t)) return "never"
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86_400)
  return `${d} day${d === 1 ? "" : "s"} ago`
}

/** "caught up 3 files, 2 min ago" from a row's last_catchup + last_catchup_at. */
export function catchupLine(r: { last_catchup?: string; last_catchup_at?: string } | undefined, now = new Date()): string {
  if (!r?.last_catchup_at) return ""
  return `${String(r.last_catchup ?? "caught up").replace(/ \(\d+ chunks?\)/, "").replace(/ from .*$/, "")}, ${ago(r.last_catchup_at, now)}`
}

// ── never a prompt without a person ────────────────────────────────────────────────────────

/**
 * Get a vault key for a step that needs one, or the reason it is skipped. `getKey` must not be able
 * to ask anybody (the daemon's runs pass a key store with no passphrase prompt): a key behind a
 * passphrase throws at once, and that becomes a plain "skipped, because …" — never a hang.
 */
export async function keyOrSkip(getKey: () => Promise<Buffer | null>, why: string): Promise<{ key: Buffer } | { skip: string }> {
  try {
    const k = await getKey()
    return k ? { key: k } : { skip: `${why}, and this machine has no key for the vault — skipped (on the machine that has it: iris vault sync)` }
  } catch (e: any) {
    return { skip: `${why}, and the key cannot be opened without a person here (${String(e?.message ?? e)}) — skipped; run in a terminal: iris vault sync` }
  }
}
