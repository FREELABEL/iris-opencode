---
name: mixxx-rig
description: Move a Mixxx DJ rig (controller mappings + audio routing) between Macs through an Atlas board — check the machine, save the rig to the board, or restore it here, with a person approving before anything is written to Atlas and before Mixxx is quit, then confirm from mixxx.log that the controller opened and the audio stream started. A thin wrapper over `iris app-config export|apply mixxx`; the rig lives on the board as the dataset `mixxx-rig`, attachments and a page, all editable by hand (`iris how-to move-a-mixxx-rig`).
version: 2
args:
  action:
    type: string
    required: false
    default: preflight
    enum: [preflight, export, export-remote, apply, verify]
    description: preflight = check this Mac only. export = save this Mac's rig to the board. export-remote = run the export on another Hive node (--node). apply = restore the board's rig here. verify = re-read mixxx.log for the four lines and script errors.
  bloq:
    type: string
    required: false
    default: ""
    description: The Atlas board (bloq id) holding the rig — dataset mixxx-rig, its attachments and the "Mixxx rig — <rig>" page. Needed by every action except preflight and verify.
  rig:
    type: string
    required: false
    default: ""
    description: The rig's name on the board. Export defaults to the machine's name; apply defaults to the only rig, or the one named after this machine.
  node:
    type: string
    required: false
    default: ""
    description: For action=export-remote only — the Hive node (as `iris hive nodes list` names it) whose Mixxx setup to save. That node needs an iris with `app-config … mixxx`.
  timeout:
    type: number
    required: false
    default: 360
    description: Seconds to wait for mixxx.log to confirm the setup. A first launch with a new library can take ~5 minutes; Mixxx buffers its log, so silence is not failure.
on-error: stop
timeout: 1800
triggers:
  - set up my DJ controller on a new Mac, move my Mixxx setup, restore a Mixxx mapping
  - back up a Mixxx controller mapping and audio routing to Atlas
  - the DDJ-T1 does not work in Mixxx on this machine
allowed-tools:
  - Read
  - Bash
---

# Mixxx rig

A Mixxx setup that works is the controller mapping files, the mixxx.cfg lines that load them,
and the audio routing. Two of those are bound to the machine (an absolute path; a device
*number*), so a copied profile breaks. `iris app-config … mixxx` carries them by **name** and
rebuilds the machine-bound parts on the target. This playbook runs those commands in order and
puts a person at the two points that matter: before anything is written to the shared board,
and before Mixxx is quit.

```
preflight ──▶ approve-write ──▶ export            (action=export)
preflight ──▶ approve-write ──▶ export-remote     (action=export-remote, on --node)
preflight ──▶ plan ──▶ approve-apply ──▶ apply ──▶ verify   (action=apply)
```

Example (the DDJ-T1 board): `iris playbook run mixxx-rig --action apply --bloq 569`.
`mode: human` steps pause the run. Do what they say, then `iris playbook resume <runId>`.
The logic lives in the CLI, not here: run any step's command by hand and you get the same
result.

## Executable Steps (v2)

### step:preflight Is Mixxx here, and which controllers and audio devices can this Mac see?

```yaml
mode: shell
if: ${{args.action}} != export-remote
```

```bash
set -uo pipefail
[ "$(uname)" = "Darwin" ] || { echo "This playbook drives Mixxx on macOS (CoreMIDI/CoreAudio)."; exit 1; }
SANDBOX="$HOME/Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx"
PLAIN="$HOME/Library/Application Support/Mixxx"
if [ -d "$SANDBOX" ]; then DIR="$SANDBOX"; elif [ -d "$PLAIN" ]; then DIR="$PLAIN"; else DIR=""; fi
[ -d /Applications/Mixxx.app ] && echo "Mixxx.app      $(defaults read /Applications/Mixxx.app/Contents/Info CFBundleShortVersionString 2>/dev/null || echo installed)" || echo "Mixxx.app      NOT INSTALLED in /Applications"
if [ -n "$DIR" ]; then echo "profile        $DIR"; else echo "profile        none yet — open Mixxx once so it creates one, then quit it"; fi
[ -n "$DIR" ] && ls "$DIR/controllers" 2>/dev/null | sed 's/^/  mapping      /'
pgrep -x Mixxx >/dev/null && echo "Mixxx          RUNNING (apply will ask before quitting it)" || echo "Mixxx          not running"

echo "MIDI ports (CoreMIDI):"
osascript -l JavaScript -e '
ObjC.import("CoreMIDI"); var out=[];
function name(e){var r=Ref();$.MIDIObjectGetStringProperty(e,$.kMIDIPropertyDisplayName,r);return ObjC.castRefToObject(r[0]).js}
for (var i=0;i<$.MIDIGetNumberOfSources();i++) out.push(name($.MIDIGetSource(i)));
for (var i=0;i<$.MIDIGetNumberOfDestinations();i++) out.push(name($.MIDIGetDestination(i)));
out.filter(function(v,i,a){return a.indexOf(v)===i}).map(function(n){return "  "+n+"   (cfg key "+n.replace(/[ \/\\]/g,"_")+")"}).join("\n") || "  none"' 2>/dev/null || echo "  (could not list)"

echo "Audio devices (CoreAudio; apply finds each route's device by these names):"
system_profiler SPAudioDataType 2>/dev/null | awk '/^        [^ ].*:$/{sub(/^ +/,"");sub(/:$/,"");print "  "$0}'

[ -n "$DIR" ] || exit 1
```

### step:approve-write A person approves writing this rig to the board

```yaml
mode: human
if: ${{args.action}} == export
depends: preflight
```

About to save this Mac's Mixxx rig to **board #${{args.bloq}}** (rig name: `${{args.rig}}`, or this
machine's name if blank). It will:

- attach each `controllers/` file — reusing an attachment that already holds the same bytes, never deleting one
- upsert the dataset `mixxx-rig` rows for this rig, and remove only this rig's rows that no longer exist
- regenerate the page "Mixxx rig — <rig>" in the *Rigs* list

If someone edited this rig's page or dataset by hand since the last export, exporting overwrites
those edits with this Mac's actual setup. Check first:
`iris app-config apply mixxx --bloq ${{args.bloq}} --dry-run` says "page and dataset agree" when nothing is pending.

Resume to go ahead, or stop the run.

### step:export Save this Mac's rig to the board

```yaml
mode: shell
if: ${{args.action}} == export
depends: approve-write
```

```bash
set -euo pipefail
BLOQ='${{args.bloq}}'
[ -n "$BLOQ" ] || { echo "This action needs --bloq <board id> (the board that holds the rig)."; exit 1; }
ARGS=(--bloq "$BLOQ")
RIG='${{args.rig}}'
[ -n "$RIG" ] && ARGS+=(--rig "$RIG")
iris app-config export mixxx "${ARGS[@]}"
```

### step:approve-remote A person approves saving another machine's rig to the board

```yaml
mode: human
if: ${{args.action}} == export-remote
```

About to run `iris app-config export mixxx --bloq ${{args.bloq}}` **on Hive node `${{args.node}}`**,
which writes that machine's rig to board #${{args.bloq}} (attachments, dataset `mixxx-rig`, page).
The node must be a Mac with Mixxx, its iris must include `app-config … mixxx`, and the daemon must
run in the logged-in user's session (the sandboxed Mixxx folder is TCC-protected from ssh).

Resume to go ahead, or stop the run.

### step:export-remote Save another machine's rig to the board, from that machine

```yaml
mode: hive
node: ${{args.node}}
if: ${{args.action}} == export-remote
depends: approve-remote
retry: 1
```

```bash
set -euo pipefail
BLOQ='${{args.bloq}}'
[ -n "$BLOQ" ] || { echo "This action needs --bloq <board id> (the board that holds the rig)."; exit 1; }
ARGS=(--bloq "$BLOQ")
RIG='${{args.rig}}'
[ -n "$RIG" ] && ARGS+=(--rig "$RIG")
iris app-config export mixxx "${ARGS[@]}"
```

### step:plan What applying would change here — writes nothing

```yaml
mode: shell
if: ${{args.action}} == apply
depends: preflight
```

```bash
set -uo pipefail
BLOQ='${{args.bloq}}'
[ -n "$BLOQ" ] || { echo "This action needs --bloq <board id> (the board that holds the rig)."; exit 1; }
ARGS=(--bloq "$BLOQ" --dry-run)
RIG='${{args.rig}}'
[ -n "$RIG" ] && ARGS+=(--rig "$RIG")
iris app-config apply mixxx "${ARGS[@]}" </dev/null
CODE=$?
# 3 = it would work, but a device is not connected here; the person decides at the next step.
[ "$CODE" = 0 ] || [ "$CODE" = 3 ] || exit "$CODE"
```

### step:approve-apply A person approves quitting Mixxx and writing the setup

```yaml
mode: human
if: ${{args.action}} == apply
depends: plan
```

Read the plan above. If it said **would write 0 file(s)**, there is nothing to do; stop the run.

Otherwise, applying will:

- **quit Mixxx** if it is running — save anything open in it first. (It has to: Mixxx rewrites
  mixxx.cfg and soundconfig.xml when it quits, which would undo the apply.)
- back up the files it replaces, install the mappings, merge the controller lines into
  mixxx.cfg and write soundconfig.xml with this Mac's device numbers
- if the board's page or dataset was edited by hand, bring the other one level with it on board #${{args.bloq}}
- start Mixxx again

Plug in the controller now if the plan said it is not connected. Resume to go ahead.

### step:apply Restore the rig here

```yaml
mode: shell
if: ${{args.action}} == apply
depends: approve-apply
timeout: 900
```

```bash
set -uo pipefail
BLOQ='${{args.bloq}}'
[ -n "$BLOQ" ] || { echo "This action needs --bloq <board id> (the board that holds the rig)."; exit 1; }
ARGS=(--bloq "$BLOQ" --quit-app --check-timeout '${{args.timeout}}')
RIG='${{args.rig}}'
[ -n "$RIG" ] && ARGS+=(--rig "$RIG")
iris app-config apply mixxx "${ARGS[@]}" </dev/null
CODE=$?
# 3 = written, but something is unconfirmed or not connected — step:verify says which.
[ "$CODE" = 0 ] || [ "$CODE" = 3 ] || exit "$CODE"
```

### step:verify Read mixxx.log until the controller opened and the audio stream started

```yaml
mode: shell
if: ${{args.action}} != preflight
timeout: 900
```

```bash
set -uo pipefail
ACTION='${{args.action}}'
[ "$ACTION" = "export" ] || [ "$ACTION" = "export-remote" ] && { echo "Export only reads Mixxx; nothing to verify here."; exit 0; }
SANDBOX="$HOME/Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx"
DIR="$SANDBOX"; [ -d "$DIR" ] || DIR="$HOME/Library/Application Support/Mixxx"
LOG="$DIR/mixxx.log"
pgrep -x Mixxx >/dev/null || { echo "Mixxx is not running; starting it."; open -b org.mixxx.mixxx; }

# What should open: the enabled controllers whose MIDI port is connected, and the routed audio devices.
CTLS=$(awk '/^\[Controller\]/{s=1;next} /^\[/{s=0} s && $2=="1"{print $1}' "$DIR/mixxx.cfg" 2>/dev/null)
DEVS=$(grep -o 'SoundDevice name="[^"]*"' "$DIR/soundconfig.xml" 2>/dev/null | sed 's/SoundDevice name="//;s/"$//')
echo "expecting controllers: ${CTLS:-none}"
echo "expecting audio devices: $(echo "$DEVS" | paste -sd, -)"

DEADLINE=$(( $(date +%s) + ${{args.timeout}} ))
while :; do
  MISSING=()
  # Mixxx names the controller by its MIDI port; the cfg key is that name with spaces → _.
  for k in $CTLS; do
    NAME=$(printf '%s' "$k" | tr '_' '.')   # . matches the space (or the _) in either spelling
    grep -Eq "Opening ${NAME} index [0-9]+ for (output|input)" "$LOG" || MISSING+=("Opening ${k} index N for output")
  done
  [ -n "$CTLS" ] && { grep -q "Starting engine" "$LOG" || MISSING+=("Starting engine"); }
  if [ -n "$DEVS" ]; then
    grep -q "Started stream successfully" "$LOG" || MISSING+=("Started stream successfully")
    CLOCK=0
    while IFS= read -r d; do [ -n "$d" ] && grep -qF "Using \"$d\" as output sound device clock reference" "$LOG" && CLOCK=1; done <<< "$DEVS"
    [ "$CLOCK" = 1 ] || MISSING+=("Using \"<device>\" as output sound device clock reference")
  fi
  [ "${#MISSING[@]}" = 0 ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "NOT CONFIRMED after ${{args.timeout}} s — mixxx.log has not shown:"
    printf '  %s\n' "${MISSING[@]}"
    echo "Mixxx buffers its log (it flushes on warnings and on quit), so this is unconfirmed, not failed."
    echo "Look at Preferences › Controllers and › Sound Hardware, or quit Mixxx and run this step again."
    exit 3
  fi
  sleep 5
done
sleep 5   # script errors land just after "Starting engine"

ERRORS=$(grep -E "(Warning|Critical|Fatal) +\[Controller\].*(\.js:[0-9]+|Uncaught|exception|SyntaxError|ReferenceError|TypeError)" "$LOG" | grep -vE "lodash\.mixxx\.js|midi-components" || true)
echo "✓ controller opened, engine started, audio stream started, clock reference set"
if [ -n "$ERRORS" ]; then
  echo "✗ $(printf '%s\n' "$ERRORS" | wc -l | tr -d ' ') controller script error(s) outside lodash.mixxx.js / midi-components:"
  printf '%s\n' "$ERRORS" | head -20 | sed 's/^/  /'
  exit 1
fi
echo "✓ no controller script errors (lodash.mixxx.js / midi-components warnings are Mixxx's own and ignored)"
```
