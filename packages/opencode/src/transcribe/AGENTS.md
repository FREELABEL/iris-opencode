# Voice code — read the standard first

This folder is part of IRIS Desktop voice (dictation, live words, held recordings, spoken replies).
It is held to **`specs/voice/standard.md`** — ten rules, among them: words appear once and in order,
nothing a person says is ever lost, never stuck, one right message, interruption is instant, and
every change ships with a test that fails without it.

Before you change anything here: read the standard, check the voice gap log (IRIS Desktop board
628, list #2841) for an existing ticket, and name the rules your change touches in the PR.
Session-ui tests run Solid's server build — `createEffect` never fires there, so put logic that must
be tested in plain functions.
