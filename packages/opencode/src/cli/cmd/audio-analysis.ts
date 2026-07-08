import { spawnSync } from "child_process"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import * as prompts from "./clack"

/**
 * Beatbox audio analysis (#158426 follow-on): compute BPM / musical key / Camelot / energy
 * from a track's MP3 with librosa, so `iris discover playlist --upload` sends the DJ crate
 * data with each import. Spotify's audio-features API is 403 for our app (deprecated), so we
 * compute it from the file ourselves.
 *
 * Uses a dedicated venv at ~/.iris/audio-analysis/.venv — created + `pip install librosa`d
 * lazily on first use (like download.ts auto-installs yt-dlp). If python3 is unavailable the
 * analyzer is skipped gracefully (analysis is optional; the upload still succeeds).
 */

export interface AudioAnalysis {
  bpm: number
  key: string
  camelot: string
  energy: number
  duration: number
}

const ANALYZE_PY = `import sys, json
import numpy as np
import librosa

KEYS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
MAJ = {0:'8B',1:'3B',2:'10B',3:'5B',4:'12B',5:'7B',6:'2B',7:'9B',8:'4B',9:'11B',10:'6B',11:'1B'}
MIN = {0:'5A',1:'12A',2:'7A',3:'2A',4:'9A',5:'4A',6:'11A',7:'6A',8:'1A',9:'8A',10:'3A',11:'10A'}
K_MAJ = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
K_MIN = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])

def analyze(path):
    y, sr = librosa.load(path, sr=22050, mono=True, duration=90)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = int(round(float(np.atleast_1d(tempo)[0])))
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    def best(p):
        cors = [np.corrcoef(np.roll(p, i), chroma)[0, 1] for i in range(12)]
        i = int(np.argmax(cors)); return i, cors[i]
    mi, mc = best(K_MAJ); ni, nc = best(K_MIN)
    if mc >= nc: idx, mode = mi, 'major'
    else: idx, mode = ni, 'minor'
    cam = (MAJ if mode == 'major' else MIN)[idx]
    rms = float(np.mean(librosa.feature.rms(y=y)))
    return {'bpm': bpm, 'key': f'{KEYS[idx]} {mode}', 'camelot': cam,
            'energy': round(min(rms * 4, 1.0), 3),
            'duration': round(float(librosa.get_duration(y=y, sr=sr)), 1)}

print(json.dumps(analyze(sys.argv[1])))
`

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" })
  const p = r.stdout.trim()
  return p && r.status === 0 ? p : null
}

let _analyzer: { python: string; script: string } | null | undefined

/**
 * Ensure a python venv with librosa + the analyzer script exist. Cached per process.
 * Returns null (and skips analysis) if python3 is missing or the install fails.
 */
function ensureAnalyzer(): { python: string; script: string } | null {
  if (_analyzer !== undefined) return _analyzer

  const dir = join(homedir(), ".iris", "audio-analysis")
  const venvPy = join(dir, ".venv", "bin", "python")
  const script = join(dir, "analyze.py")

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(script, ANALYZE_PY)
  } catch {
    _analyzer = null
    return _analyzer
  }

  const librosaOk = (py: string) =>
    existsSync(py) && spawnSync(py, ["-c", "import librosa"], { stdio: "pipe" }).status === 0

  if (librosaOk(venvPy)) {
    _analyzer = { python: venvPy, script }
    return _analyzer
  }

  const py3 = which("python3")
  if (!py3) {
    prompts.log.warn("python3 not found — skipping audio analysis (BPM/key). Install python3 to enable.")
    _analyzer = null
    return _analyzer
  }

  const sp = prompts.spinner()
  sp.start("Setting up audio analysis (one-time, installing librosa)…")
  spawnSync(py3, ["-m", "venv", join(dir, ".venv")], { stdio: "pipe", timeout: 120_000 })
  spawnSync(venvPy, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "librosa"], {
    stdio: "pipe",
    timeout: 600_000,
  })
  if (librosaOk(venvPy)) {
    sp.stop("Audio analysis ready")
    _analyzer = { python: venvPy, script }
  } else {
    sp.stop("Audio analysis unavailable (librosa install failed) — continuing without it", 1)
    _analyzer = null
  }
  return _analyzer
}

/**
 * Analyze one MP3 → { bpm, key, camelot, energy, duration }, or null if analysis is
 * unavailable/failed (caller should treat analysis as optional).
 */
export function analyzeAudio(mp3Path: string): AudioAnalysis | null {
  const a = ensureAnalyzer()
  if (!a) return null
  const r = spawnSync(a.python, [a.script, mp3Path], { encoding: "utf8", timeout: 180_000 })
  if (r.status === 0 && r.stdout.trim()) {
    try {
      return JSON.parse(r.stdout.trim())
    } catch {}
  }
  return null
}
