import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-lexicon-agreements.css"
import {
  AGREEMENT_TYPES,
  BUCKET_WORD,
  BUCKETS,
  canRevoke,
  caseOf,
  emptyRaise,
  issueBlock,
  issueVerb,
  matches,
  raisePayload,
  raiseProblem,
  recipients,
  shortHash,
  stateWord,
  tally,
  toneOf,
  trailWord,
  waitLine,
  type Agreement,
  type AgreementDetail,
  type Bucket,
  type RaiseForm,
} from "./iris-lexicon-agreements-model"

/**
 * Lexicon › Agreements (#192484, epic #192479): engagement letters, fee agreements, releases and the
 * rest, filed against cases — the Desktop face of `iris lexicon agreements`.
 *
 * TWO THINGS HERE REACH SOMEONE OUTSIDE THE FIRM: Issue (emails a signing link) and Revoke (withdraws
 * access they relied on). Neither runs from one click — each opens a confirm that names who receives
 * it. Raise only ever saves a draft. There is no Sign: a signature must be the signer's own.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type ListPayload = { measured: boolean; reason?: string; summary?: Record<string, number>; agreements: Agreement[] }
type DetailPayload = { measured: boolean; reason?: string } & AgreementDetail
type ActionPayload = { measured: boolean; reason?: string; agreement: Agreement | null }
type Confirm = { kind: "issue" | "revoke"; a: Agreement }

function Ic(props: { name: IconProps["name"]; title?: string }) {
  return (
    <span class="iris-lex-ic" title={props.title} aria-hidden={props.title ? undefined : "true"}>
      <Icon name={props.name} size="small" />
    </span>
  )
}

export function IrisLexiconAgreements(props: { doFetch: Fetch; initialCase?: string }) {
  const [caseDraft, setCaseDraft] = createSignal(props.initialCase ?? "")
  const [caseRef, setCaseRef] = createSignal(props.initialCase ?? "")
  const [bucket, setBucket] = createSignal<Bucket>("all")
  const [selected, setSelected] = createSignal<number>()
  const [raising, setRaising] = createSignal<RaiseForm>()
  const [confirm, setConfirm] = createSignal<Confirm>()
  const [reason, setReason] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [note, setNote] = createSignal<string>()

  const readJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await props.doFetch(path, init)
    const body = (await res.json().catch(() => null)) as T | null
    if (!body) throw new Error(`HTTP ${res.status}`)
    return body
  }

  // An object, not the string: "" (every case) is falsy, and a falsy source never fetches.
  const [list, { refetch: refetchList }] = createResource(() => ({ c: caseRef() }), async ({ c }): Promise<ListPayload> => {
    try {
      return await readJson<ListPayload>(`/iris/agreements${c.trim() ? `?case=${encodeURIComponent(c.trim())}` : ""}`)
    } catch (e: any) {
      return { measured: false, reason: e?.message ?? String(e), agreements: [] }
    }
  })
  const [detail, { refetch: refetchDetail }] = createResource(selected, async (id): Promise<DetailPayload> => {
    try {
      return await readJson<DetailPayload>(`/iris/agreements/${id}`)
    } catch (e: any) {
      return { measured: false, reason: e?.message ?? String(e), agreement: null, document: null, seal: null, trail: [] }
    }
  })

  const rows = createMemo(() => list.latest?.agreements ?? [])
  const counts = createMemo(() => tally(rows()))
  const visible = createMemo(() => rows().filter((a) => matches(a, bucket())))
  // The row is what we have instantly; the detail call adds the document and the trail.
  const current = createMemo(() => {
    const id = selected()
    const d = detail.latest
    if (d?.agreement && d.agreement.id === id) return d.agreement
    return rows().find((a) => a.id === id)
  })

  createEffect(() => {
    if (selected() === undefined && !raising() && visible()[0]) setSelected(visible()[0].id)
  })

  function applyCase(e?: Event) {
    e?.preventDefault()
    setSelected(undefined)
    setCaseRef(caseDraft().trim())
  }

  async function act(path: string, body: unknown, done: (a: Agreement | null) => string): Promise<Agreement | null | false> {
    setBusy(true)
    setError(undefined)
    setNote(undefined)
    try {
      const r = await readJson<ActionPayload>(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
      if (!r.measured) {
        setError(r.reason ?? "fl-api refused")
        return false
      }
      setNote(done(r.agreement))
      await refetchList()
      if (selected() !== undefined) await refetchDetail()
      return r.agreement
    } catch (e: any) {
      setError(e?.message ?? String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitRaise(e: Event) {
    e.preventDefault()
    const f = raising()
    if (!f) return
    const problem = raiseProblem(f)
    if (problem) return setError(problem)
    const a = await act("/iris/agreements", raisePayload(f), (x) =>
      `Draft #${x?.id ?? "?"} raised for ${f.name.trim()}. Nothing has been sent — issue it when the wording is approved.`,
    )
    if (a === false) return
    setRaising(undefined)
    if (f.case.trim() !== caseRef()) {
      setCaseDraft(f.case.trim())
      setCaseRef(f.case.trim())
    }
    if (a) setSelected(a.id)
  }

  async function runConfirm() {
    const c = confirm()
    if (!c) return
    const who = c.a.counterparty
    if (c.kind === "issue") {
      const ok = await act(`/iris/agreements/${c.a.id}/issue`, {}, () => `Signing link emailed to ${who}.`)
      if (ok !== false) setConfirm(undefined)
      return
    }
    if (!reason().trim()) return setError("Say why — it is recorded on the audit chain.")
    const ok = await act(`/iris/agreements/${c.a.id}/revoke`, { reason: reason().trim() }, () => `Revoked. Any access it authorised for ${who} is closed.`)
    if (ok !== false) setConfirm(undefined)
  }

  function openConfirm(kind: Confirm["kind"], a: Agreement) {
    setError(undefined)
    setReason("")
    setConfirm({ kind, a })
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirm() && !busy()) {
        setConfirm(undefined)
        e.preventDefault()
      }
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  const setField = (k: keyof RaiseForm) => (e: { currentTarget: { value: string } }) =>
    setRaising((f) => (f ? { ...f, [k]: e.currentTarget.value } : f))

  return (
    <div class="iris-lex" data-slot="iris-lexicon-agreements">
      <form class="iris-lex-head" onSubmit={applyCase}>
        <label class="iris-lex-search">
          <Ic name="magnifying-glass" />
          <input
            aria-label="Case"
            placeholder="Every case — or a case id"
            value={caseDraft()}
            onInput={(e) => setCaseDraft(e.currentTarget.value)}
            onBlur={() => caseDraft().trim() !== caseRef() && applyCase()}
          />
          <Show when={caseDraft()}>
            <button type="button" class="iris-lex-icon-btn" title="Every case" aria-label="Clear case" onClick={() => { setCaseDraft(""); applyCase() }}>
              <Icon name="close-small" size="small" />
            </button>
          </Show>
        </label>
        <span class="iris-lex-meta">
          <Show when={list.latest?.measured && list.latest.summary}>
            {(s) => (
              <>
                {s().awaiting ?? 0} awaiting · {s().executed ?? 0} executed
                <Show when={(s().expiringSoon ?? 0) > 0}> · <span data-tone="warn">{s().expiringSoon} expiring</span></Show>
              </>
            )}
          </Show>
        </span>
        <span class="iris-lex-spacer" />
        <button type="button" class="iris-lex-icon-btn" title="Refresh" aria-label="Refresh" disabled={list.loading} onClick={() => refetchList()}>
          <Show when={list.loading} fallback={<Icon name="refresh" size="small" />}>
            <Spinner class="iris-lex-spin" />
          </Show>
        </button>
        <button
          type="button"
          class="iris-lex-btn"
          data-primary
          onClick={() => {
            setError(undefined)
            setNote(undefined)
            setConfirm(undefined)
            setRaising(emptyRaise(caseRef()))
          }}
        >
          <Icon name="plus-small" size="small" />
          Raise
        </button>
      </form>

      <Show when={error()}>
        <div class="iris-lex-callout" data-tone="bad" role="alert">
          <Ic name="warning" />
          <span>{error()}</span>
        </div>
      </Show>
      <Show when={note()}>
        <div class="iris-lex-callout" data-tone="good" role="status">
          <Ic name="circle-check" />
          <span>{note()}</span>
        </div>
      </Show>

      <div class="iris-lex-filters" role="toolbar" aria-label="Filter agreements">
        <For each={BUCKETS}>
          {(b) => (
            <button class="iris-lex-filter" aria-pressed={bucket() === b} onClick={() => { setBucket(b); setSelected(undefined) }}>
              {BUCKET_WORD[b]}
              <span>{counts()[b]}</span>
            </button>
          )}
        </For>
      </div>

      <div class="iris-lex-body">
        <div class="iris-lex-list" role="listbox" aria-label="Agreements">
          <Show
            when={list.latest?.measured !== false}
            fallback={
              <div class="iris-lex-empty">
                <Ic name="warning" />
                Couldn't read agreements: {list.latest?.reason}
              </div>
            }
          >
            <Show when={!(list.loading && !list.latest)} fallback={<div class="iris-lex-empty"><Spinner class="iris-lex-spin" /></div>}>
              <For
                each={visible()}
                fallback={
                  <div class="iris-lex-empty">
                    {caseRef() ? `No agreements on case ${caseRef()}${bucket() === "all" ? "" : ` in ${BUCKET_WORD[bucket()]}`}.` : "No case agreements yet."}
                  </div>
                }
              >
                {(a) => (
                  <button
                    class="iris-lex-row"
                    role="option"
                    data-id={a.id}
                    aria-selected={!raising() && selected() === a.id}
                    onClick={() => {
                      setRaising(undefined)
                      setSelected(a.id)
                    }}
                  >
                    <div class="iris-lex-row-top">
                      <span class="iris-lex-row-name">{a.counterparty}</span>
                      <span class="iris-lex-state" data-tone={toneOf(a)}>{stateWord(a)}</span>
                    </div>
                    <div class="iris-lex-row-sub">
                      {a.kind ?? a.type}
                      <Show when={caseOf(a.subjectRef)}>{(c) => <> · case {c()}</>}</Show>
                      <Show when={waitLine(a)}>{(w) => <> · {w()}</>}</Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="iris-lex-detail">
          <Show when={!raising()} fallback={RaisePane()}>
            <Show when={current()} fallback={<div class="iris-lex-empty">Pick an agreement</div>}>
              {(a) => DetailPane(a)}
            </Show>
          </Show>
        </div>
      </div>

      <Show when={confirm()}>{(c) => ConfirmDialog(c)}</Show>
    </div>
  )

  function DetailPane(a: () => Agreement) {
    const d = () => (detail.latest?.agreement?.id === a().id ? detail.latest : undefined)
    const blocked = () => issueBlock(a())
    return (
      <>
        <div class="iris-lex-title">
          <div>
            <div class="iris-lex-name">{a().counterparty}</div>
            <div class="iris-lex-sub">{[a().kind ?? a().type, a().org].filter(Boolean).join(" · ")}</div>
          </div>
          <span class="iris-lex-pill" data-tone={toneOf(a())}>{stateWord(a())}</span>
        </div>

        <Show when={waitLine(a())}>
          {(w) => (
            <div class="iris-lex-callout" data-tone={toneOf(a())}>
              <Ic name="clock" />
              <span>{w()}</span>
            </div>
          )}
        </Show>

        <dl class="iris-lex-fields">
          <Show when={caseOf(a().subjectRef)}><dt>Case</dt><dd>{caseOf(a().subjectRef)}</dd></Show>
          <dt>Between</dt>
          <dd>{a().disclosingParty ?? "—"} and {a().counterparty}</dd>
          <dt>Email</dt>
          <dd>{a().email ?? "—"}</dd>
          <Show when={a().issuedAt}><dt>Issued</dt><dd>{a().issuedAt}</dd></Show>
          <Show when={a().executedAt}><dt>Executed</dt><dd>{a().executedAt}</dd></Show>
          <Show when={a().revokedAt}><dt>Revoked</dt><dd>{a().revokedAt}</dd></Show>
          <dt>Expires</dt>
          <dd>{a().expiryDate ?? "Runs until revoked"}</dd>
          <dt>Seal</dt>
          <dd>
            <Show when={d()?.seal} fallback={shortHash(a().documentHash) ?? "Unsealed"}>
              {(s) => (
                <span data-tone={s().status === "intact" ? "good" : s().status === "mismatch" ? "bad" : undefined}>
                  {s().status === "intact"
                    ? `Intact · ${shortHash(s().chain) ?? ""}`
                    : s().status === "mismatch"
                      ? "MISMATCH — the stored text no longer matches what was sealed"
                      : (s().detail ?? "Unsealed")}
                </span>
              )}
            </Show>
          </dd>
        </dl>

        <Show when={a().partyLinks.length > 1}>
          <div class="iris-lex-section">Parties · {a().partiesSigned}/{a().partiesTotal} signed</div>
          <ul class="iris-lex-parties">
            <For each={a().partyLinks}>
              {(p) => (
                <li>
                  <Ic name={p.status === "signed" ? "circle-check" : "clock"} />
                  <span class="iris-lex-party-name">{p.name ?? "—"}</span>
                  <span class="iris-lex-weak">{p.role}</span>
                  <span class="iris-lex-weak" data-tone={p.status === "signed" ? "good" : undefined}>{p.status}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={detail.loading && !d()}>
          <div class="iris-lex-empty"><Spinner class="iris-lex-spin" /></div>
        </Show>
        <Show when={detail.latest && !detail.latest.measured && selected() === a().id}>
          <div class="iris-lex-callout" data-tone="bad"><Ic name="warning" /><span>Couldn't read the document: {detail.latest!.reason}</span></div>
        </Show>

        <Show when={d()?.document}>
          {(doc) => (
            <details class="iris-lex-doc">
              <summary>
                <Ic name="open-file" />
                {doc().reference ?? doc().title ?? "Document"}
              </summary>
              <Show when={doc().preamble}><p class="iris-lex-doc-pre">{doc().preamble}</p></Show>
              <ol>
                <For each={doc().clauses}>
                  {(c) => (
                    <li>
                      <Show when={c.heading}><strong>{c.heading}</strong> </Show>
                      {c.body}
                    </li>
                  )}
                </For>
              </ol>
              <Show when={doc().recordNote}><p class="iris-lex-weak">{doc().recordNote}</p></Show>
            </details>
          )}
        </Show>

        <Show when={(d()?.trail.length ?? 0) > 0}>
          <div class="iris-lex-section">Audit trail</div>
          <ol class="iris-lex-trail">
            <For each={d()!.trail}>
              {(e) => (
                <li>
                  <span>{trailWord(e.action)}</span>
                  <span class="iris-lex-weak">{e.at ?? ""}</span>
                </li>
              )}
            </For>
          </ol>
        </Show>

        <div class="iris-lex-actions">
          <button
            class="iris-lex-btn"
            data-primary
            disabled={busy() || !!blocked()}
            title={blocked() ?? `Email the signing link to ${a().counterparty}`}
            onClick={() => openConfirm("issue", a())}
          >
            <Icon name="send" size="small" />
            {issueVerb(a())}
          </button>
          <Show when={canRevoke(a())}>
            <button class="iris-lex-btn" data-tone="bad" disabled={busy()} title="Withdraw it and close the access it authorised" onClick={() => openConfirm("revoke", a())}>
              <Icon name="circle-ban-sign" size="small" />
              Revoke
            </button>
          </Show>
          <Show when={blocked() && a().status !== "executed"}>
            <span class="iris-lex-weak">{blocked()}</span>
          </Show>
        </div>
      </>
    )
  }

  function RaisePane() {
    const f = () => raising()!
    const t = () => AGREEMENT_TYPES.find((x) => x.id === f().type)
    return (
      <form class="iris-lex-form" onSubmit={submitRaise}>
        <div class="iris-lex-title">
          <div>
            <div class="iris-lex-name">Raise an agreement</div>
            <div class="iris-lex-sub">Saved as a draft. Nothing is sent until you issue it.</div>
          </div>
          <button type="button" class="iris-lex-icon-btn" title="Cancel" aria-label="Cancel" onClick={() => setRaising(undefined)}>
            <Icon name="close" size="small" />
          </button>
        </div>
        <div class="iris-lex-grid">
          <label>Case<input required value={f().case} onInput={setField("case")} placeholder="Lead id or case ref" /></label>
          <label>
            Type
            <select value={f().type} onChange={setField("type")}>
              <For each={AGREEMENT_TYPES}>{(x) => <option value={x.id}>{x.label}</option>}</For>
            </select>
          </label>
          <label>Signer<input required value={f().name} onInput={setField("name")} placeholder="As named in the document" /></label>
          <label>Signer's email<input type="email" value={f().email} onInput={setField("email")} placeholder="Needed to issue" /></label>
          <label>Organisation<input value={f().org} onInput={setField("org")} placeholder="Optional" /></label>
          <label>Issuing firm<input required value={f().firm} onInput={setField("firm")} placeholder="As named in the document" /></label>
          <label>Term<input value={f().term} onInput={setField("term")} placeholder='e.g. "two years"' /></label>
          <label>Expires<input value={f().expires} onInput={setField("expires")} placeholder="YYYY-MM-DD" /></label>
          <label class="iris-lex-wide">Template<input value={f().template} onInput={setField("template")} placeholder="Contract template slug — or paste the wording below" /></label>
          <label class="iris-lex-wide">
            Wording
            <textarea
              value={f().body}
              onInput={setField("body")}
              placeholder={t()?.defaultWording ? "Optional — this type has default wording" : "The attorney-approved wording. It is sealed exactly as written."}
            />
          </label>
        </div>
        <div class="iris-lex-actions">
          <button class="iris-lex-btn" data-primary type="submit" disabled={busy()}>
            <Show when={busy()} fallback={<Icon name="save" size="small" />}><Spinner class="iris-lex-spin" /></Show>
            Raise draft
          </button>
          <button class="iris-lex-btn" type="button" onClick={() => setRaising(undefined)}>Cancel</button>
          <Show when={raiseProblem(f())}>{(p) => <span class="iris-lex-weak">{p()}</span>}</Show>
        </div>
      </form>
    )
  }

  function ConfirmDialog(c: () => Confirm) {
    const issue = () => c().kind === "issue"
    const who = () => recipients(c().a)
    return (
      <div class="iris-lex-scrim" onClick={(e) => e.target === e.currentTarget && !busy() && setConfirm(undefined)}>
        <div class="iris-lex-dialog" role="alertdialog" aria-modal="true" aria-labelledby="iris-lex-dialog-title">
          <div class="iris-lex-dialog-icon" data-tone={issue() ? undefined : "bad"}>
            <Icon name={issue() ? "send" : "circle-ban-sign"} />
          </div>
          <div id="iris-lex-dialog-title" class="iris-lex-name">
            {issue() ? `${issueVerb(c().a)} the signing link?` : "Revoke this agreement?"}
          </div>
          <p class="iris-lex-sub">
            {issue()
              ? `${c().a.kind ?? c().a.type} #${c().a.id}. This emails a signing link to:`
              : `${c().a.kind ?? c().a.type} #${c().a.id}. Access it authorised closes for:`}
          </p>
          <ul class="iris-lex-recipients">
            <For each={issue() ? who() : who().slice(0, 1)}>
              {(r) => (
                <li>
                  <Ic name="at" />
                  <span class="iris-lex-party-name">{r.name}</span>
                  <span class="iris-lex-weak">{r.email ?? r.role}</span>
                </li>
              )}
            </For>
          </ul>
          <Show
            when={issue()}
            fallback={
              <label class="iris-lex-reason">
                Why? Recorded on the audit chain.
                <textarea value={reason()} onInput={(e) => setReason(e.currentTarget.value)} placeholder="engagement ended" autofocus />
              </label>
            }
          >
            <div class="iris-lex-callout" data-tone="warn">
              <Ic name="lock" />
              <span>Anyone holding that link can sign. It goes to the address above only.</span>
            </div>
          </Show>
          <div class="iris-lex-dialog-actions">
            <button class="iris-lex-btn" disabled={busy()} onClick={() => setConfirm(undefined)} autofocus={issue()}>
              Cancel
            </button>
            <button
              class="iris-lex-btn"
              data-primary
              data-tone={issue() ? undefined : "bad"}
              disabled={busy() || (!issue() && !reason().trim())}
              onClick={runConfirm}
            >
              <Show when={busy()}><Spinner class="iris-lex-spin" /></Show>
              {issue() ? `Send to ${c().a.counterparty}` : `Revoke for ${c().a.counterparty}`}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
