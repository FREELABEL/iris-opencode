# The IRIS voice standard

Voice is the most personal surface in IRIS Desktop: a person talks to it and it talks back. It is
held to the bar of the best dictation and voice products people already use. "Works on my machine"
and "the transcript is right in the end" are not the bar. These are, and a change that breaks one
does not ship.

It covers everything a person sees or hears: dictation (quick takes, background takes), live words,
held recordings, and spoken replies. Code: `packages/opencode/src/transcribe/`, the routes in
`packages/opencode/src/server/routes/instance/httpapi/transcribe.ts`,
`packages/session-ui/src/v2/components/prompt-input/` (dictation, live text, speech),
`packages/app/src/context/spoken-replies.ts`. The relay is `fl-iris-api` `services/stt-relay`.

## The ten rules

1. **Words appear once, in the order they were said.** Live words never repeat a sentence, never
   jump backwards, and are replaced in place by the final transcript with no visible jump. Nothing
   else is drawn over them (no placeholder, no stale text). *Broken by: #189546.*

2. **Nothing a person says is ever lost.** Audio is on disk before any network call. Navigation,
   a closed window, a crash, being offline, a cap — every path ends with the take transcribed or
   **held with Retry**, never discarded unless the person discards it. *Broken by: #189519, #189520.*
   **Deliberate deletion is a decision, not loss (#191998).** A take is segments: any edit, delete or
   Send closes the open one, and what was said before that moment is the person's. The recording
   cannot bring it back into the message. The final transcript refines only the open segment, and
   when it cannot be matched confidently what is on screen stays. The full transcript and recording
   stay recoverable through "Full transcript" and never land in the message by themselves.

3. **Fast enough to feel instant.** Budgets, p50 on a normal connection:
   | Moment | Budget |
   |---|---|
   | press → microphone open | < 300 ms |
   | first spoken word → first live word | < 1 s |
   | stop → final text (30 s take) | < 2 s |
   | reply text → first spoken audio | < 1 s |

4. **Never stuck.** Every state has a bounded exit: "Transcribing…" ends in ≤ 2 minutes (then the
   take is held); every recording state has a visible stop; no spinner without a way out.
   *Broken by: #189522.*

5. **One message, and the right one.** A failure produces at most one notice, written in the
   person's terms and language, naming a fix that works on their platform and for how they signed
   in. Never a terminal command for an app user, never an engine name that is not true, never the
   STT wording for a TTS failure. *Broken by: #189517, #189521, #189524, #189539.*

6. **Interruption is instant and total.** Stop speaking silences within 100 ms and for the rest of
   the reply, not one step of it. Dictation never records IRIS's own voice. *Broken by: #189518.*

7. **The interface tells the truth.** The clock runs only while audio is captured; the microphone
   shown is the one recording, or the fallback is said; "Keep recording" keeps recording on every
   platform. *Broken by: #189519, #189532.*

8. **No hidden cost, no surprise data.** Audio leaves the machine only for a feature the person can
   see. Silence is never uploaded. Retries never pay twice for work already done. A board marked
   for PHI never reaches a cloud engine. *Broken by: #189526, #189528.*

9. **The same everywhere.** Both composers and macOS, Windows and Linux behave the same. A gap is a
   ticket on the voice gap log (board 628, list #2841), not a shrug.

10. **Proven, not hoped.** Every voice change ships with a test that fails without it (break the
    fix and watch the test fail), and a release that touches voice passes the **desktop-voice-qa**
    device script — by ear, on a real Mac and a real Windows machine — before it ships.

## How this is used

- **Building:** read this before changing voice code; say in the PR which rules the change touches.
- **Reviewing:** a PR that weakens a rule is not merged without a ticket explaining the trade.
- **Releasing:** `desktop-voice-qa` checks every rule that a unit test cannot (sound, echo,
  autoplay, real microphones).
- **Supporting:** `desktop-voice-doctor` maps a person's complaint to the rule it broke.
