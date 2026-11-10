import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { usePlatform } from "@/context/platform"
import { ago, checksSummary, diffLines, STATE_LABEL, type Load, type Pr } from "./github-pr-model"
import "./github-pr-view.css"

/**
 * A GitHub pull request drawn inside the Browser tab (#192937).
 *
 * github.com sends X-Frame-Options: DENY, so a PR link could only ever bounce to the system
 * browser. The sidecar reads the PR from the GitHub API (/iris/github/pr — its token never
 * reaches the webview) and this draws it: state, branches, checks, description, the diff,
 * and the conversation. Anything it does not show is one click away on GitHub.
 *
 * Plain signals, not createResource, for the same reason as SessionWebTab: a resource read here
 * would suspend the side panel's <Suspense> and blank every tab switch.
 */

export { isGithubPrUrl } from "./github-pr-model"

export function GithubPrView(props: { url: string; base: string; reloadKey: number }) {
  const platform = usePlatform()
  const [load, setLoad] = createSignal<Load>({ state: "loading" })

  createEffect(
    on([() => props.url, () => props.reloadKey], ([url]) => {
      setLoad({ state: "loading" })
      ;(platform.fetch ?? globalThis.fetch)(`${props.base}/iris/github/pr?url=${encodeURIComponent(url)}`, {
        headers: { Accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the engine answered ${r.status}`))))
        .then((body: { state?: string; pr?: Pr; reason?: string; signedIn?: boolean }) => {
          if (props.url !== url) return // a later link won the race
          if (body.state === "ok" && body.pr) return setLoad({ state: "ok", pr: body.pr })
          if (body.state === "no-access")
            return setLoad({ state: "no-access", reason: body.reason ?? "GitHub refused", signedIn: !!body.signedIn })
          setLoad({ state: "error", reason: body.reason ?? "GitHub did not answer" })
        })
        .catch((err: unknown) => {
          // An older sidecar has no /iris/github/pr route: say so instead of a blank pane.
          if (props.url === url) setLoad({ state: "error", reason: err instanceof Error ? err.message : String(err) })
        })
    }),
  )

  const openOnGithub = () => platform.openExternal(props.url)

  return (
    <div class="gh-pr" data-component="github-pr-view">
      <Switch>
        <Match when={load().state === "loading"}>
          <div class="gh-pr__note">Loading pull request…</div>
        </Match>
        <Match when={load().state === "no-access" && (load() as Extract<Load, { state: "no-access" }>)}>
          {(l) => (
            <div class="gh-pr__note" data-slot="pr-no-access">
              <div class="gh-pr__note-title">GitHub won't show this pull request here</div>
              <div>
                {l().signedIn
                  ? "The GitHub login on this computer can't see this repository."
                  : "It's in a private repository. Sign in to GitHub on this computer (run gh auth login), then reload."}
              </div>
              <div class="gh-pr__reason">{l().reason}</div>
              <button type="button" class="gh-pr__button" onClick={openOnGithub}>
                Open on GitHub
              </button>
            </div>
          )}
        </Match>
        <Match when={load().state === "error" && (load() as Extract<Load, { state: "error" }>)}>
          {(l) => (
            <div class="gh-pr__note" data-slot="pr-error">
              <div class="gh-pr__note-title">Couldn't load this pull request</div>
              <div class="gh-pr__reason">{l().reason}</div>
              <button type="button" class="gh-pr__button" onClick={openOnGithub}>
                Open on GitHub
              </button>
            </div>
          )}
        </Match>
        <Match when={load().state === "ok" && (load() as Extract<Load, { state: "ok" }>).pr}>
          {(pr) => <PrBody pr={pr()} onOpen={openOnGithub} />}
        </Match>
      </Switch>
    </div>
  )
}

function PrBody(props: { pr: Pr; onOpen: () => void }) {
  const failing = createMemo(() => props.pr.checks.some((c) => c.state === "failure"))
  return (
    <div class="gh-pr__scroll" data-slot="pr-body">
      <header class="gh-pr__head">
        <div class="gh-pr__repo">
          {props.pr.owner}/{props.pr.repo} <span class="gh-pr__num">#{props.pr.number}</span>
        </div>
        <h2 class="gh-pr__title">{props.pr.title}</h2>
        <div class="gh-pr__meta">
          <span class="gh-pr__state" data-state={props.pr.state}>
            {STATE_LABEL[props.pr.state]}
          </span>
          <span>
            <b>{props.pr.author}</b> · <code>{props.pr.head}</code> → <code>{props.pr.base}</code>
          </span>
        </div>
        <div class="gh-pr__stats">
          <span class="gh-pr__add">+{props.pr.additions}</span>
          <span class="gh-pr__del">−{props.pr.deletions}</span>
          <span>
            {props.pr.changedFiles} {props.pr.changedFiles === 1 ? "file" : "files"} · {props.pr.commits}{" "}
            {props.pr.commits === 1 ? "commit" : "commits"} · updated {ago(props.pr.updatedAt)}
          </span>
          <button type="button" class="gh-pr__button gh-pr__button--inline" onClick={props.onOpen}>
            Open on GitHub
          </button>
        </div>
      </header>

      <Show when={props.pr.checks.length}>
        <details class="gh-pr__section" open={failing()} data-slot="pr-checks">
          <summary>
            Checks <span class="gh-pr__summary">{checksSummary(props.pr.checks)}</span>
          </summary>
          <ul class="gh-pr__checks">
            <For each={props.pr.checks}>
              {(c) => (
                <li>
                  <span class="gh-pr__dot" data-state={c.state} />
                  <span class="gh-pr__check-name">{c.name}</span>
                  <span class="gh-pr__check-state">{c.state}</span>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>

      <Show when={props.pr.body.trim()}>
        <section class="gh-pr__section gh-pr__desc" data-slot="pr-description">
          <Markdown text={props.pr.body} class="text-12-regular" />
        </section>
      </Show>

      <section class="gh-pr__section" data-slot="pr-files">
        <div class="gh-pr__section-title">Files changed</div>
        <For each={props.pr.files}>
          {(f) => (
            <details class="gh-pr__file">
              <summary>
                <span class="gh-pr__path">{f.path}</span>
                <span class="gh-pr__add">+{f.additions}</span>
                <span class="gh-pr__del">−{f.deletions}</span>
              </summary>
              <Show when={f.patch} fallback={<div class="gh-pr__reason gh-pr__pad">No text diff (binary, renamed, or too large).</div>}>
                {(patch) => (
                  <pre class="gh-pr__diff">
                    <For each={diffLines(patch())}>{(l) => <div data-kind={l.kind}>{l.text || " "}</div>}</For>
                  </pre>
                )}
              </Show>
              <Show when={f.truncated}>
                <div class="gh-pr__reason gh-pr__pad">Diff cut short here — the rest is on GitHub.</div>
              </Show>
            </details>
          )}
        </For>
        <Show when={props.pr.changedFiles > props.pr.files.length}>
          <div class="gh-pr__reason gh-pr__pad">
            Showing {props.pr.files.length} of {props.pr.changedFiles} files — the rest are on GitHub.
          </div>
        </Show>
      </section>

      <Show when={props.pr.comments.length}>
        <section class="gh-pr__section" data-slot="pr-comments">
          <div class="gh-pr__section-title">Conversation</div>
          <For each={props.pr.comments}>
            {(c) => (
              <div class="gh-pr__comment">
                <div class="gh-pr__comment-head">
                  <b>{c.author}</b>
                  <Show when={c.kind === "review" && c.state}>
                    <span class="gh-pr__review" data-state={c.state}>
                      {c.state === "APPROVED" ? "approved" : c.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed"}
                    </span>
                  </Show>
                  <span class="gh-pr__when">{ago(c.at)}</span>
                </div>
                <Show when={c.body.trim()}>
                  <Markdown text={c.body} class="text-12-regular" />
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>
    </div>
  )
}
