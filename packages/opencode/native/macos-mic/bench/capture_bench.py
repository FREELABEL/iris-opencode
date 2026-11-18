#!/usr/bin/env python3
"""
capture_bench — which way of opening the microphone should macOS dictation use? (#189875, #189828)

Plays a fixed sentence through the speakers a set time after each capture method is started,
records it, and transcribes the recording on-device. Per method, N runs, interleaved:

  ttfa       time from spawn to the first audio byte                      MEASURED
  integrity  audio delivered / time it was delivered over (1.00 = none lost) MEASURED
  accuracy   character similarity of the transcript to the sentence      MEASURED
  start      did the transcript keep the first words ("I need")           MEASURED
  onset      when the sentence starts after the press                    SCENARIO (chosen, not measured)

Standard library only. Runs on the Mac being measured — capture depends on that machine's audio
hardware, so a remote node's numbers would be about a different machine.

  python3 capture_bench.py [--runs 5] [--onset 0.3] [--helper PATH] [--methods a,b] [--out results.json]

Exit 1, printing no table, if the tie-out fails: the scorer cannot read the reference sentence, or
a helper's own byte count disagrees with what was received.
"""
import json
import os
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import wave

SENTENCE = "I need a 3D model of a BMW 750Li"
BYTES_PER_SECOND = 32000  # 16 kHz mono PCM16
TAIL_S = 0.6  # keep recording this long after playback ends
WHISPER = "/opt/homebrew/bin/whisper-cli"
MODEL = os.path.expanduser("~/.whisper/ggml-base.en.bin")


def opt(name, default):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else default


RUNS = int(opt("--runs", "5"))
ONSET = float(opt("--onset", "0.3"))
HELPER = opt("--helper", "/tmp/ratetest/iris-mic-dev")
OUT = opt("--out", "capture_bench_results.json")
FFMPEG_PCM = ["-af", "pan=mono|c0=c0", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "-flush_packets", "1", "pipe:1"]
METHODS = {
    # The shipped path: what capture.ts runs today, on the system default input.
    "ffmpeg-default": ["ffmpeg", "-hide_banner", "-nostdin", "-f", "avfoundation", "-i", ":default", *FFMPEG_PCM],
    # The shipped path with the built-in mic chosen in Settings.
    "ffmpeg-builtin": ["ffmpeg", "-hide_banner", "-nostdin", "-f", "avfoundation", "-i", ":MacBook Pro Microphone", *FFMPEG_PCM],
    "helper-avengine": [HELPER, "--backend", "avengine"],
    "helper-auhal": [HELPER, "--backend", "auhal"],
}
chosen = opt("--methods", ",".join(METHODS)).split(",")
METHODS = {k: v for k, v in METHODS.items() if k in chosen}


def norm(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def similarity(a, b):
    """1 - Levenshtein(a, b) / len(b), floored at 0."""
    if not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return max(0.0, 1 - prev[-1] / len(b))


def write_wav(path, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)


def transcribe(path):
    r = subprocess.run([WHISPER, "-m", MODEL, "-f", path, "-nt", "-np", "-l", "en"], capture_output=True, text=True, timeout=120)
    return " ".join(r.stdout.split())


def run_once(name, argv, ref_audio, tmp):
    t0 = time.monotonic()
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    chunks, first, err = [], [None], []

    def read_out():
        while True:
            b = proc.stdout.read1(4096)
            if not b:
                return
            if first[0] is None:
                first[0] = time.monotonic() - t0
            chunks.append(b)

    def read_err():
        err.append(proc.stderr.read().decode("utf8", "replace"))

    ro, re_ = threading.Thread(target=read_out), threading.Thread(target=read_err)
    ro.start(), re_.start()
    time.sleep(max(0.0, ONSET - (time.monotonic() - t0)))
    subprocess.run(["afplay", ref_audio])
    time.sleep(TAIL_S)
    t_stop = time.monotonic() - t0
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    ro.join(), re_.join()
    pcm = b"".join(chunks)
    audio_s = len(pcm) / BYTES_PER_SECOND
    ttfa = first[0]
    path = os.path.join(tmp, f"{name}-{int(t0 * 1000)}.wav")
    write_wav(path, pcm)
    text = transcribe(path) if pcm else ""
    stop_evt = None
    for line in "".join(err).splitlines():
        if '"event":"stop"' in line.replace(" ", ""):
            try:
                stop_evt = json.loads(line[line.index("{"):])
            except ValueError:
                pass
    return {
        "method": name,
        "ttfa_s": ttfa,
        "integrity": (audio_s / (t_stop - ttfa)) if ttfa is not None and t_stop > ttfa else 0.0,
        "audio_s": audio_s,
        "bytes": len(pcm),
        "helper_bytes": stop_evt.get("out_bytes") if stop_evt else None,
        "transcript": text,
        "accuracy": similarity(norm(text), norm(SENTENCE)),
        "kept_start": norm(text).startswith("ineed"),
    }


def main():
    tmp = tempfile.mkdtemp(prefix="capture-bench-")
    aiff, ref = os.path.join(tmp, "ref.aiff"), os.path.join(tmp, "ref.wav")
    subprocess.run(["say", "-o", aiff, SENTENCE], check=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", ref], check=True)

    # TIE-OUT 1: the scorer must be able to read the reference itself, or accuracy means nothing.
    ref_text = transcribe(ref)
    ref_acc = similarity(norm(ref_text), norm(SENTENCE))
    if ref_acc < 0.85:
        print(f"TIE-OUT FAILED: whisper reads the reference file as {ref_text!r} ({ref_acc:.2f}) — accuracy would be meaningless.")
        sys.exit(1)

    rows = []
    for r in range(RUNS):
        for name, argv in METHODS.items():
            row = run_once(name, argv, aiff, tmp)
            rows.append(row)
            print(f"  round {r + 1}/{RUNS} {name:16s} ttfa {row['ttfa_s'] if row['ttfa_s'] is None else round(row['ttfa_s'], 3)}s"
                  f"  integrity {row['integrity']:.2f}  acc {row['accuracy']:.2f}  {row['transcript'][:60]!r}", flush=True)

    # TIE-OUT 2: a helper's own count of what it wrote must equal what arrived.
    bad = [r for r in rows if r["helper_bytes"] is not None and r["helper_bytes"] != r["bytes"]]
    if bad:
        print(f"TIE-OUT FAILED: {len(bad)} run(s) where the helper wrote a different byte count than was received, e.g. {bad[0]['helper_bytes']} vs {bad[0]['bytes']}.")
        sys.exit(1)

    json.dump({"sentence": SENTENCE, "onset_s": ONSET, "runs": RUNS, "reference_transcript": ref_text,
               "rows": rows}, open(OUT, "w"), indent=2)

    print(f"\nReference sentence: {SENTENCE!r}; scorer reads the clean file as {ref_text!r} ({ref_acc:.2f}).")
    print(f"Onset {ONSET}s after start is a SCENARIO input. Every other column is MEASURED, N={RUNS} per method.\n")
    hdr = f"{'method':16s} {'ttfa med':>9s} {'ttfa worst':>10s} {'integrity med':>13s} {'acc med':>8s} {'acc worst':>9s} {'kept start':>10s}"
    print(hdr)
    print("-" * len(hdr))
    summary = {}
    for name in METHODS:
        rs = [r for r in rows if r["method"] == name]
        tt = [r["ttfa_s"] for r in rs if r["ttfa_s"] is not None]
        s = {
            "ttfa_med": statistics.median(tt) if tt else None,
            "ttfa_worst": max(tt) if tt else None,
            "int_med": statistics.median(r["integrity"] for r in rs),
            "acc_med": statistics.median(r["accuracy"] for r in rs),
            "acc_worst": min(r["accuracy"] for r in rs),
            "kept": sum(r["kept_start"] for r in rs),
            "ttfa_all": tt,
        }
        summary[name] = s
        f = lambda v: "n/a" if v is None else f"{v:.3f}s"
        print(f"{name:16s} {f(s['ttfa_med']):>9s} {f(s['ttfa_worst']):>10s} {s['int_med']:>13.2f} {s['acc_med']:>8.2f} {s['acc_worst']:>9.2f} {s['kept']:>6d}/{len(rs)}")

    # THE FLIP — from the table's own measured ttfa values, not a separate run.
    print("\nTHE FLIP — the onset is the one input this does not measure (when a person starts talking).")
    print("Share of runs that would lose the first words, by onset:")
    onsets = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5]
    print(f"{'method':16s} " + " ".join(f"{o:>6.2f}s" for o in onsets))
    for name, s in summary.items():
        cells = []
        for o in onsets:
            n = len(s["ttfa_all"])
            cells.append("   n/a" if not n else f"{sum(t > o for t in s['ttfa_all']) / n:>6.0%} ")
        print(f"{name:16s} " + " ".join(cells))
    valid = {k: v for k, v in summary.items() if v["int_med"] >= 0.9 and v["ttfa_med"] is not None}
    dropped = [k for k in summary if k not in valid]
    if dropped:
        print(f"\nDisqualified (integrity < 0.90 — audio lost, speed is irrelevant): {', '.join(dropped)}")
    if valid:
        worst = max(v["ttfa_worst"] for v in valid.values())
        best = min(valid, key=lambda k: valid[k]["ttfa_med"])
        print(f"Fastest valid method: {best} (median {valid[best]['ttfa_med']:.3f}s).")
        print(f"Above an onset of {worst:.2f}s every valid method keeps the first words, and the speed ranking stops mattering.")
    print(f"\nRaw per-run rows: {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
