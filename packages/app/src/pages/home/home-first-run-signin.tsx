import { Show, createSignal, onMount } from "solid-js"
import { Spinner } from "./home-first-run-art"

/**
 * Sign-in as step one of first run, inside the app (EPIC #188210).
 *
 * It used to be a second window (packages/desktop/public/login.html) opened over this one, so a
 * new user saw two IRIS windows and a live "Connect Gmail" that could only fail. This is the
 * same flow — same endpoints, same Tauri commands, same funnel events — on the page they are
 * already looking at.
 *
 * The window is still the fallback: Rust opens it if no screen claims sign-in within a few
 * seconds of launch (`signin_in_app`), so a webview that fails to load is never a dead end.
 */

const API = "https://raichu.heyiris.io"

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>

function tauriInvoke(): Invoke | undefined {
  return (window as any).__TAURI__?.core?.invoke
}

const GOOGLE_REASONS: Record<string, string> = {
  access_denied: "Google sign-in was cancelled. Try again, or use an email code.",
  email_not_verified: "That Google account's email isn't verified. Use an email code instead.",
  timed_out: "Sign-in timed out. Try again.",
}

async function post(path: string, body: unknown) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  })
  let data: any = {}
  try {
    data = await r.json()
  } catch {}
  if (!r.ok) throw new Error(data.message || data.error || `Request failed (${r.status})`)
  return data
}

export function SignInPanel() {
  const invoke = tauriInvoke()
  const track = (event: string, label?: string) => {
    try {
      void invoke?.("track_onboarding", { event, label: label ?? null })?.catch?.(() => {})
    } catch {}
  }

  const [stage, setStage] = createSignal<"start" | "code" | "done">("start")
  const [busy, setBusy] = createSignal<"" | "google" | "send" | "verify">("")
  const [msg, setMsg] = createSignal<{ text: string; kind?: "err" | "ok" }>({ text: "" })
  const [email, setEmail] = createSignal("")
  const [promo, setPromo] = createSignal("")
  const [showPromo, setShowPromo] = createSignal(false)
  const [code, setCode] = createSignal("")
  let codeInput: HTMLInputElement | undefined
  let promoInput: HTMLInputElement | undefined

  onMount(() => {
    // Tell the shell this screen owns sign-in, so it doesn't open the window over it.
    void invoke?.("signin_in_app")?.catch?.(() => {})
  })

  async function finish(token: string, method: string) {
    setStage("done")
    setMsg({ text: "Signed in. Starting IRIS…", kind: "ok" })
    await invoke!("save_iris_token", { token })
    // After the save: Rust attaches the token now on disk, which joins this install to the person.
    track("onboarding.signed_in", method)
    // The engine reads the key once, at start — the restart is what makes it signed in.
    await new Promise((r) => setTimeout(r, 600))
    await invoke!("restart_app")
  }

  async function google() {
    if (!invoke) return setMsg({ text: "Sign-in needs the IRIS desktop app.", kind: "err" })
    setBusy("google")
    track("onboarding.signin_method", "google")
    setMsg({ text: "Finish signing in in your browser…" })
    try {
      const r = await invoke("google_sign_in")
      await finish(r.token, "google")
    } catch (e: any) {
      const why = String(e?.message ?? e)
      setMsg({ text: GOOGLE_REASONS[why] ?? `Google sign-in didn't finish (${why}). Try again, or use an email code.`, kind: "err" })
    } finally {
      setBusy("")
    }
  }

  async function sendCode(e: Event) {
    e.preventDefault()
    const to = email().trim()
    if (!to) return setMsg({ text: "Enter your email address.", kind: "err" })
    const key = promo().trim().toUpperCase()
    setBusy("send")
    setMsg({ text: "Sending…" })
    track("onboarding.signin_method", "code")
    try {
      // Exactly the CLI's payload; see login.html for why each field is there.
      const data = await post("/api/v1/auth/send-login-code", {
        email: to,
        method: "with_login_code",
        expiration_minutes: 30,
        auto_create: true,
        ...(key ? { promo_code: key } : {}),
      })
      track("onboarding.code_sent")
      const t = data?.data?.trial
      const note = t?.granted
        ? t.kind === "license"
          ? `Licence applied — ${t.tier || "your"} plan.`
          : `Trial applied — ${(t.credits || 0).toLocaleString()} credits added.`
        : key
          ? t?.error || "That code could not be applied."
          : ""
      setStage("code")
      setMsg(note ? { text: note, kind: /applied/.test(note) ? "ok" : "err" } : { text: "" })
      queueMicrotask(() => codeInput?.focus())
    } catch (err: any) {
      setMsg({ text: err.message, kind: "err" })
    } finally {
      setBusy("")
    }
  }

  async function verify(e: Event) {
    e.preventDefault()
    const c = code().trim().replace(/\s/g, "")
    if (c.length < 6) return setMsg({ text: "Enter the 6-digit code.", kind: "err" })
    setBusy("verify")
    setMsg({ text: "Verifying…" })
    try {
      const data = await post("/api/v1/auth/login-with-code", {
        email: email().trim(),
        login_code: c,
        generate_sdk_token: true,
        sdk_token_name: "IRIS Desktop",
        sdk_token_expires_days: 365,
        generate_dashboard_url: true,
      })
      // Nested: data.data.sdk_token.key. data.sdk_token is an object, and writing that would
      // save "[object Object]" as the credential.
      const token = data?.data?.sdk_token?.key
      if (!token) throw new Error("Signed in, but no token was returned. Contact support.")
      if (!invoke) throw new Error("Sign-in needs the IRIS desktop app.")
      await finish(token, "code")
    } catch (err: any) {
      setMsg({ text: err.message, kind: "err" })
    } finally {
      setBusy("")
    }
  }

  return (
    <div class="fr-signin">
      <Show when={stage() === "start"}>
        <button class="fr-google" type="button" disabled={!!busy()} onClick={() => void google()}>
          <Show
            when={busy() === "google"}
            fallback={
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
                <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.8-6z" />
                <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z" />
              </svg>
            }
          >
            <Spinner />
          </Show>
          Continue with Google
        </button>

        <div class="fr-or">or use an email code</div>

        <form class="flex flex-col gap-3" onSubmit={sendCode}>
          <input
            class="fr-input"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            aria-label="Email"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <Show when={showPromo()}>
            <input
              ref={promoInput}
              class="fr-input fr-mono"
              placeholder="Trial code or licence key"
              aria-label="Trial code or licence key"
              autocapitalize="characters"
              value={promo()}
              onInput={(e) => setPromo(e.currentTarget.value)}
            />
            <p class="text-v2-text-text-muted -mt-1 text-[12px]">
              Without one you still sign in and use IRIS on the free allowance.
            </p>
          </Show>
          <button class="fr-primary" type="submit" disabled={!!busy()}>
            {busy() === "send" ? "Sending…" : "Send code"}
          </button>
        </form>

        <Show when={!showPromo()}>
          <button
            class="fr-link mx-auto"
            type="button"
            onClick={() => {
              setShowPromo(true)
              queueMicrotask(() => promoInput?.focus())
            }}
          >
            Have a trial code or licence key?
          </button>
        </Show>
      </Show>

      <Show when={stage() === "code"}>
        <p class="text-v2-text-text-muted text-center text-[14px]">
          We sent a 6-digit code to <span class="text-v2-text-text-base">{email().trim()}</span>.
        </p>
        <form class="flex flex-col gap-3" onSubmit={verify}>
          <input
            ref={codeInput}
            class="fr-input fr-mono text-center text-[20px] tracking-[0.4em]"
            inputmode="numeric"
            maxlength="6"
            placeholder="000000"
            aria-label="6-digit code"
            value={code()}
            onInput={(e) => setCode(e.currentTarget.value)}
          />
          <button class="fr-primary" type="submit" disabled={!!busy()}>
            {busy() === "verify" ? "Verifying…" : "Sign in"}
          </button>
        </form>
        <button
          class="fr-link mx-auto"
          type="button"
          onClick={() => {
            setStage("start")
            setCode("")
            setMsg({ text: "" })
          }}
        >
          Use a different email
        </button>
      </Show>

      <Show when={msg().text}>
        <p
          class="text-center text-[13px]"
          classList={{
            "text-v2-text-text-muted": !msg().kind,
            "fr-err": msg().kind === "err",
            "fr-ok": msg().kind === "ok",
          }}
          aria-live="polite"
        >
          {msg().text}
        </p>
      </Show>

      <p class="text-v2-text-text-faint text-center text-[12px]">
        Signing in here signs in the <span class="text-v2-text-text-muted">iris</span> CLI too.
      </p>
    </div>
  )
}
