import { createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { Button, type ButtonProps } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { StatusBadge } from "@opencode-ai/ui/status-badge"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { formatIrisLine, outcomeOf, parseIrisLine, runIris, type IrisRunResult } from "@/utils/iris-run"
import "./command-action.css"

/**
 * CommandAction (#194581): a button that RUNS an `iris …` command, instead of copying it.
 *
 *   <CommandAction command="iris hive connect" label="Add this computer" describe="…" onDone={refetch} />
 *
 * - The engine runs it (`POST /iris/run`: the installed CLI only, argv, no shell).
 * - A READ runs at once; progress on the button, the result in a toast (or `result="inline"`).
 * - A WRITE — anything that is not clearly a read — opens a confirm that says in words what it
 *   will do and shows the command, and runs only on "Run it". The engine refuses it otherwise.
 * - `editable` opens the command line first, for commands that need a value (a path, a name).
 * - "Copy CLI" stays, in the overflow menu beside the button, for people who want the terminal.
 *
 * `openCommandRun()` is the same flow without a button (the command palette uses it).
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type T = ReturnType<typeof useLanguage>["t"]
export type IrisRunner = (argv: readonly string[], confirmed: boolean) => Promise<IrisRunResult>

/** A runner bound to this window's engine. */
export function useIrisRunner(override?: { fetch?: Fetch; base?: string }): IrisRunner {
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  return (argv, confirmed) =>
    runIris(override?.fetch ?? platform.fetch ?? globalThis.fetch, override?.base ?? serverSDK().url, argv, confirmed)
}

export interface CommandActionProps {
  /** The full line, e.g. `iris hive connect` or `iris drives scan "/Volumes/Footage"`. */
  command: string
  /** The verb on the button, in words: "Add this computer", "Scan this drive". */
  label: JSX.Element
  /** What it does, in plain words, for the confirm. Say what changes and where. */
  describe?: string
  /** Let the person change the line before it runs (a path, a name). */
  editable?: boolean
  /** Known to change something: go straight to the confirm. Without it the engine decides. */
  write?: boolean
  variant?: ButtonProps["variant"]
  size?: ButtonProps["size"]
  icon?: ButtonProps["icon"]
  /** Where the result goes for a read: a toast (default) or a block under the button. */
  result?: "toast" | "inline"
  /** After every finished run (refetch here). */
  onDone?: (r: IrisRunResult) => void
  /** Hide "Copy CLI" (rare: only when the line would mean nothing to a person). */
  noCopy?: boolean
  /** For panes that talk to the engine through their own fetch. */
  fetch?: Fetch
  base?: string
  class?: string
}

export function CommandAction(props: CommandActionProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const run = useIrisRunner({ fetch: props.fetch, base: props.base })
  const [busy, setBusy] = createSignal(false)
  const [last, setLast] = createSignal<IrisRunResult>()

  const finish = (r: IrisRunResult) => {
    props.onDone?.(r)
    if (props.result === "inline") return setLast(r)
    toastResult(language.t, r)
  }
  const flow = (start: "edit" | "confirm") =>
    openCommandRun(dialog, { line: props.command, start, describe: props.describe, run, t: language.t, onDone: (r) => props.onDone?.(r) })

  const click = async () => {
    if (busy()) return
    if (props.editable) return flow("edit")
    if (props.write) return flow("confirm")
    const parsed = parseIrisLine(props.command)
    if ("error" in parsed) return flow("edit")
    setBusy(true)
    const r = await run(parsed.argv, false).finally(() => setBusy(false))
    if (r.needsConfirm) return flow("confirm")
    finish(r)
  }

  return (
    <div data-component="command-action" class={props.class}>
      <div data-slot="command-action-row">
        <Button
          variant={props.variant ?? "primary"}
          size={props.size ?? "small"}
          icon={busy() ? undefined : props.icon}
          disabled={busy()}
          aria-busy={busy() ? "true" : undefined}
          onClick={() => void click()}
        >
          <Show when={busy()}>
            <Spinner class="command-action-spinner" />
          </Show>
          {busy() ? language.t("command.run.running") : props.label}
        </Button>
        <Show when={!props.noCopy}>
          <DropdownMenu gutter={4} placement="bottom-end">
            <DropdownMenu.Trigger
              as={IconButton}
              icon="dot-grid"
              variant="ghost"
              size={props.size === "large" ? "normal" : "small"}
              aria-label={language.t("command.run.more")}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item onSelect={() => copyLine(language.t, props.command)}>
                  <DropdownMenu.ItemLabel>{language.t("command.run.copyCli")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Show>
      </div>
      <Show when={props.result === "inline" && last()}>
        {(r) => <RunResultView r={r()} t={language.t} />}
      </Show>
    </div>
  )
}

export function copyLine(t: T, line: string) {
  void navigator.clipboard
    ?.writeText(line)
    .then(() => showToast({ variant: "success", icon: "check", description: t("command.run.copied") }))
    .catch(() => showToast({ description: line }))
}

export function toastResult(t: T, r: IrisRunResult) {
  const o = outcomeOf(r)
  showToast({
    variant: o.tone === "success" ? "success" : "error",
    icon: o.tone === "success" ? "circle-check" : "warning",
    title: t(`command.run.${o.title}`),
    description: o.detail || undefined,
  })
}

/** The finished run: status, the line it ended on, and the output. */
function RunResultView(props: { r: IrisRunResult; t: T }) {
  const o = () => outcomeOf(props.r)
  const output = () => [props.r.stdout, props.r.stderr].filter((s) => s && s.trim()).join("\n").trim()
  return (
    <div data-slot="command-action-result" data-tone={o().tone} role="status">
      <div data-slot="command-action-result-head">
        <StatusBadge tone={o().tone} mark="dot" size="small">
          {props.t(`command.run.${o().title}`)}
        </StatusBadge>
        <Show when={o().detail}>
          <span data-slot="command-action-result-detail">{o().detail}</span>
        </Show>
      </div>
      <Show when={output()}>
        <pre data-slot="command-action-output">{output()}</pre>
      </Show>
      <Show when={props.r.truncated}>
        <p data-slot="command-action-note">{props.t("command.run.truncated")}</p>
      </Show>
    </div>
  )
}

export interface CommandRunOptions {
  line: string
  /** "edit": the line first, changeable. "confirm": straight to the confirm (a known write). */
  start: "edit" | "confirm"
  describe?: string
  run: IrisRunner
  t: T
  onDone?: (r: IrisRunResult) => void
}

/** Open the run flow in the app's Dialog: edit → (confirm, for a write) → running → result. */
export function openCommandRun(dialog: ReturnType<typeof useDialog>, opts: CommandRunOptions) {
  void dialog.show(() => <CommandRunDialog {...opts} close={() => dialog.close()} />)
}

type Stage = "edit" | "confirm" | "running" | "result"

function CommandRunDialog(props: CommandRunOptions & { close: () => void }) {
  const t = props.t
  const [line, setLine] = createSignal(props.line)
  const [stage, setStage] = createSignal<Stage>(props.start)
  const [error, setError] = createSignal<string>()
  const [result, setResult] = createSignal<IrisRunResult>()
  const parsed = () => parseIrisLine(line())
  const shown = () => {
    const p = parsed()
    return "argv" in p ? formatIrisLine(p.argv) : line().trim()
  }

  const go = async (confirmed: boolean) => {
    const p = parsed()
    if ("error" in p) {
      setError(t(p.error === "chained" ? "command.run.error.chained" : p.error === "not-iris" ? "command.run.error.notIris" : "command.run.error.empty"))
      return setStage("edit")
    }
    setError(undefined)
    setStage("running")
    const r = await props.run(p.argv, confirmed)
    if (r.needsConfirm && !confirmed) return setStage("confirm")
    setResult(r)
    setStage("result")
    props.onDone?.(r)
  }

  const title = () =>
    stage() === "confirm" ? t("command.run.confirm.title") : stage() === "result" ? t("command.run.result.title") : t("command.run.dialog.title")

  return (
    <Dialog fit size="normal" title={title()} class="command-run-dialog">
      <div data-component="command-run" data-stage={stage()}>
        <Switch>
          <Match when={stage() === "edit"}>
            <form
              data-slot="command-run-form"
              onSubmit={(e) => {
                e.preventDefault()
                void go(false)
              }}
            >
              <TextField
                data-slot="command-run-input"
                label={t("command.run.dialog.label")}
                value={line()}
                onChange={(v) => {
                  setLine(v)
                  setError(undefined)
                }}
                autofocus
                spellcheck={false}
                autocomplete="off"
                error={error()}
                description={props.describe ?? t("command.run.dialog.hint")}
              />
              <div data-slot="command-run-actions">
                <Button type="button" variant="ghost" icon="copy" onClick={() => copyLine(t, line().trim())}>
                  {t("command.run.dialog.copy")}
                </Button>
                <span data-slot="command-run-spacer" />
                <Button type="button" variant="secondary" onClick={props.close}>
                  {t("command.run.dialog.cancel")}
                </Button>
                <Button type="submit" variant="primary" icon="play">
                  {t("command.run.dialog.run")}
                </Button>
              </div>
            </form>
          </Match>

          <Match when={stage() === "confirm"}>
            <div data-slot="command-run-confirm">
              <p data-slot="command-run-lead">{props.describe ?? t("command.run.confirm.generic")}</p>
              <p data-slot="command-run-why">{t("command.run.confirm.why")}</p>
              <div data-slot="command-run-label">{t("command.run.confirm.command")}</div>
              <code data-slot="command-run-line">{shown()}</code>
              <div data-slot="command-run-actions">
                <Button type="button" variant="ghost" icon="copy" onClick={() => copyLine(t, shown())}>
                  {t("command.run.dialog.copy")}
                </Button>
                <span data-slot="command-run-spacer" />
                <Button type="button" variant="secondary" onClick={props.close}>
                  {t("command.run.dialog.cancel")}
                </Button>
                <Button type="button" variant="primary" icon="play" autofocus onClick={() => void go(true)}>
                  {t("command.run.confirm.run")}
                </Button>
              </div>
            </div>
          </Match>

          <Match when={stage() === "running"}>
            <div data-slot="command-run-running" role="status">
              <Spinner />
              <span>{t("command.run.running")}</span>
              <code data-slot="command-run-line">{shown()}</code>
            </div>
          </Match>

          <Match when={stage() === "result" && result()}>
            {(r) => (
              <div data-slot="command-run-result">
                <code data-slot="command-run-line">{shown()}</code>
                <RunResultView r={r()} t={t} />
                <div data-slot="command-run-actions">
                  <Show when={r().ran && r().stdout}>
                    <Button type="button" variant="ghost" icon="copy" onClick={() => copyLine(t, [r().stdout, r().stderr].filter(Boolean).join("\n"))}>
                      {t("command.run.result.copyOutput")}
                    </Button>
                  </Show>
                  <span data-slot="command-run-spacer" />
                  <Button type="button" variant="secondary" onClick={() => setStage("edit")}>
                    {t("command.run.result.edit")}
                  </Button>
                  <Button type="button" variant="primary" onClick={props.close}>
                    {t("command.run.result.close")}
                  </Button>
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
