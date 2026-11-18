---
name: talking-head-reel
description: Turn raw takes of a person talking to camera into a finished vertical reel — pick the best take and cut its pauses, burn word-by-word captions, pick sharp cover frames, have a person watch it, register it into a board's Review Studio, then (only after that worked, and only with a yes) delete the raw takes. Runs on this machine with ffmpeg and on-device whisper.cpp; nothing is uploaded until the register step.
version: 2
args:
  takes:
    type: string
    required: false
    default: ""
    description: The raw takes, comma-separated (paths may contain spaces, not commas). Needed by step:cut only. Two or more takes of the same script lets `cut` choose; one take is just cut.
  title:
    type: string
    required: false
    default: ""
    description: Drawn large on each cover, and used as the item title when registering. Leave blank for clean covers.
  script:
    type: string
    required: false
    default: ""
    description: A text file with the script. When given, the take that says the most of it wins; otherwise the one with the most speech and the fewest long pauses.
  bloq:
    type: number
    required: false
    description: The board (bloq id) whose Review Studio the reel is registered into. Needed only for step:register.
  dir:
    type: string
    required: false
    default: "./reel"
    description: Working folder. Every step writes its file here and the next step reads it.
  action:
    type: string
    required: false
    default: prep
    enum: [prep, cut, captions, covers, review, register, clear]
    description: prep = cut → captions → covers in one run. Any other value runs that one step. review, register and clear only ever run on their own, so a person is always between the render and anything that uploads or deletes.
on-error: stop
timeout: 3600
triggers:
  - someone filmed themselves talking to camera and wants a reel out of it
  - cut the pauses out of a take, jump-cut a talking head, pick the best take
  - add word-by-word captions to a vertical video, burn in subtitles
  - pick a cover or thumbnail frame for a reel
allowed-tools:
  - Read
  - Bash
---

# Talking-head reel

IRIS can render films made in code (`genesis-motion`, Remotion). This is the other lane: footage
of a real person. It chains the three `iris reel` verbs, puts a person in front of the result,
and only then uploads or deletes anything.

```
takes ──cut──▶ cut.mp4 ──captions──▶ captioned.mp4 (+ .ass .srt) ──covers──▶ covers/cover-N.jpg
                                                       │
                                        review (a person watches)
                                                       │
                              register ──▶ registered.ok ──clear──▶ raw takes deleted
```

| step | reads | writes |
|---|---|---|
| cut | the raw takes (+ script) | `cut.mp4`, `cut.json`, `takes.txt` |
| captions | `cut.mp4` | `captioned.mp4`, `captioned.ass`, `captioned.srt`, `captions.json` |
| covers | `captioned.mp4` | `covers/cover-1.jpg …`, `covers.json` |
| review | `captioned.mp4`, `covers/` | `review.ok` (written by the person's yes) |
| register | `captioned.mp4`, `covers/`, `review.ok` | `register.log`, `registered.ok` |
| clear | `takes.txt`, `registered.ok` | — (deletes the takes listed in `takes.txt`) |

Because every hand-off is a file, any step can be re-run on its own (`--action captions`) after
tweaking a flag, without redoing the ones before it.

## Quick reference

```bash
iris playbook run talking-head-reel --takes "take1.mov,take2.mov" --title "One agent, many playbooks"
iris playbook run talking-head-reel --action review
iris playbook run talking-head-reel --action register --bloq 38
iris playbook run talking-head-reel --action clear

# the verbs underneath
iris reel cut take1.mov take2.mov --script script.txt --out reel/cut.mp4
iris reel captions reel/cut.mp4 --style pop --position lower --srt
iris reel covers reel/captioned.mp4 --count 3 --title "One agent, many playbooks"
```

## Steps

### step:cut Pick the best take and cut its pauses

```yaml
mode: shell
```

```bash
set -euo pipefail
case '${{args.action}}' in prep|cut) ;; *) echo "skipped (action=${{args.action}})"; exit 0 ;; esac
DIR='${{args.dir}}'
mkdir -p "$DIR"

# Comma-separated, so a path with a space in it survives.
IFS=',' read -r -a RAW <<< '${{args.takes}}'
TAKES=()
for t in "${RAW[@]}"; do
  t="$(echo "$t" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$t" ] && continue
  [ -f "$t" ] || { echo "Take not found: $t"; exit 1; }
  TAKES+=("$t")
done
[ "${#TAKES[@]}" -gt 0 ] || { echo "No takes given (--takes \"a.mov,b.mov\")"; exit 1; }

SCRIPT='${{args.script}}'
EXTRA=()
[ -n "$SCRIPT" ] && EXTRA+=(--script "$SCRIPT")

iris reel cut "${TAKES[@]}" ${EXTRA[@]+"${EXTRA[@]}"} --out "$DIR/cut.mp4" --json > "$DIR/cut.json"

# The list of raw takes is what step:clear deletes — and nothing else.
printf '%s\n' "${TAKES[@]}" > "$DIR/takes.txt"
python3 - "$DIR/cut.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
for t in r["takes"]:
    cov = f"  script {round(t['coverage'] * 100)}%" if t.get("coverage") is not None else ""
    print(f"{t['file']}: {t['duration']:.1f}s long, {t['speech']:.1f}s speech, {t['pauses']} pauses ({t['longPauses']} long), score {t['score']}{cov}")
print(f"best take: {r['best']} — {r['reason']}")
print(f"cut: {r['before']:.1f}s -> {r['after']:.1f}s  ->  {r['out']}")
PY
```

### step:captions Burn word-by-word captions

```yaml
mode: shell
```

```bash
set -euo pipefail
case '${{args.action}}' in prep|captions) ;; *) echo "skipped (action=${{args.action}})"; exit 0 ;; esac
DIR='${{args.dir}}'
[ -f "$DIR/cut.mp4" ] || { echo "No $DIR/cut.mp4 — run step:cut first (--action cut)"; exit 1; }
iris reel captions "$DIR/cut.mp4" --out "$DIR/captioned.mp4" --style pop --position lower --srt --json > "$DIR/captions.json"
cat "$DIR/captions.json"
```

### step:covers Pick cover frames

```yaml
mode: shell
```

```bash
set -euo pipefail
case '${{args.action}}' in prep|covers) ;; *) echo "skipped (action=${{args.action}})"; exit 0 ;; esac
DIR='${{args.dir}}'
SRC="$DIR/captioned.mp4"
[ -f "$SRC" ] || SRC="$DIR/cut.mp4"
[ -f "$SRC" ] || { echo "No $DIR/captioned.mp4 or cut.mp4 — run step:cut first"; exit 1; }
TITLE='${{args.title}}'
EXTRA=()
[ -n "$TITLE" ] && EXTRA+=(--title "$TITLE")
iris reel covers "$SRC" --count 3 --out "$DIR/covers" ${EXTRA[@]+"${EXTRA[@]}"} --json > "$DIR/covers.json"
cat "$DIR/covers.json"
echo
echo "Next: a person watches it —  iris playbook run talking-head-reel --dir '$DIR' --action review"
```

### step:review A person watches the cut

```yaml
mode: human
if: ${{args.action}} == review
```

```
Watch ${{args.dir}}/captioned.mp4 start to finish, with sound, on a phone if you can.
- Did the cut clip a word, or leave a breath that drags? Re-run step:cut with a different
  --pad (more = safer joints) or --min-silence, then captions and covers again.
- Are the captions right? Fix a misheard word in captioned.ass and re-burn, or re-run captions.
- Is it the right take? cut.json says which won and why.
- Open ${{args.dir}}/covers/. Is there one you would post?
When it is good:  touch ${{args.dir}}/review.ok
Then:  iris playbook run talking-head-reel --dir ${{args.dir}} --action register --bloq <board>
```

### step:register Register the reel and covers into the board's Review Studio

```yaml
mode: shell
if: ${{args.action}} == register
confirm: true
```

```bash
set -euo pipefail
DIR='${{args.dir}}'
BOARD='${{args.bloq}}'
TITLE='${{args.title}}'
[ -n "$BOARD" ] && [ "$BOARD" != "0" ] || { echo "register needs --bloq <board id>"; exit 1; }
[ -f "$DIR/review.ok" ] || { echo "No $DIR/review.ok — a person has not approved the cut (step:review)"; exit 1; }
[ -f "$DIR/captioned.mp4" ] || { echo "No $DIR/captioned.mp4"; exit 1; }
rm -f "$DIR/registered.ok"

# `iris remotion register` takes --board (the bloq id). One video, then the covers as one carousel.
ARGS=(--board "$BOARD")
[ -n "$TITLE" ] && ARGS+=(--title "$TITLE")
iris remotion register "$DIR/captioned.mp4" "${ARGS[@]}" 2>&1 | tee "$DIR/register.log"
shopt -s nullglob
COVERS=("$DIR"/covers/cover-*.jpg)
if [ "${#COVERS[@]}" -gt 0 ]; then
  iris remotion register "${COVERS[@]}" --board "$BOARD" --title "${TITLE:-Reel} — covers" 2>&1 | tee -a "$DIR/register.log"
fi

# Only reached when every register above exited 0 (set -e + pipefail). step:clear reads this.
date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/registered.ok"
echo "Registered. Raw takes can now be cleared:  iris playbook run talking-head-reel --dir '$DIR' --action clear"
```

### step:clear Delete the raw takes (only after register succeeded)

```yaml
mode: shell
if: ${{args.action}} == clear
confirm: true
```

```bash
set -euo pipefail
DIR='${{args.dir}}'
[ -f "$DIR/registered.ok" ] || { echo "Refusing: $DIR/registered.ok is missing, so register has not succeeded. Nothing deleted."; exit 1; }
[ -f "$DIR/takes.txt" ] || { echo "Refusing: no $DIR/takes.txt — nothing records which files are the raw takes."; exit 1; }
[ "$DIR/registered.ok" -nt "$DIR/cut.mp4" ] || { echo "Refusing: the cut is newer than the last register. Register this cut first."; exit 1; }

# Deletes exactly the files step:cut recorded, never a glob.
while IFS= read -r take; do
  [ -z "$take" ] && continue
  if [ -f "$take" ]; then rm -- "$take" && echo "deleted  $take"; else echo "already gone  $take"; fi
done < "$DIR/takes.txt"
echo "Kept: $DIR/cut.mp4, $DIR/captioned.mp4, $DIR/covers/"
```

## What this does not do yet

- **No face awareness in covers.** Covers are the sharpest frames, spread out in time. A frame
  with a screen recording or on-screen text can outscore the speaker's face; with plain
  talking-head footage it picks the in-focus moments, but it does not know where the eyes are.
- **Silence is loudness, not speech.** `cut` finds pauses with ffmpeg `silencedetect`. Music or
  room noise under the voice hides the pauses; raise the threshold (`--noise 30`) or record clean.
  It also cannot tell a flubbed line from a good one — use `--script` to pick between takes.
- **One take in the output.** It picks the best whole take; it does not splice the best line from
  each take together.
- **Captions are whisper base.en.** English only, and names or jargon can be misheard — the
  review step is where those get fixed (edit `captioned.ass`, re-burn).
- **No publishing.** Register puts the reel in a board's Review Studio as a pending creative. Posting
  it is a separate, deliberate step (`editorial-ad`, `competitive-marketing`).
- **No music or reframing.** It does not score the reel or crop a 16:9 take to 9:16 around the face;
  a landscape take is centre-cropped on covers and captioned at its own aspect.
