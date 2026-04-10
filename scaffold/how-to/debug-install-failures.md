# How to: Debug IRIS CLI install failures

## What this does

Diagnoses and fixes common failure modes when a user runs `curl -fsSL https://heyiris.io/install-code | bash` and something breaks. Based on real-world debugging from April 8, 2026 session with 5 distinct failure modes discovered and fixed.

## Prerequisites

- User attempted the install and got an error (screenshot, terminal output, or verbal description)
- You have access to the iris-opencode repo on GitHub

## Quick diagnostic command (send this to the user)

```bash
{ echo "=== OS / Shell ==="; uname -a; sw_vers -productVersion 2>/dev/null; echo "Bash: $BASH_VERSION"
  echo; echo "=== CPU ==="; sysctl -n machdep.cpu.brand_string 2>/dev/null
  echo "AVX2_0: $(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 'n/a')"
  echo "AVX2:   $(sysctl -n hw.optional.avx2 2>/dev/null || echo 'n/a')"
  echo; echo "=== Required commands ==="; for c in curl grep sed mktemp chmod mkdir unzip jq python3 node git brew; do
    command -v "$c" >/dev/null && printf "✓ %-10s %s\n" "$c" "$(command -v $c)" || printf "✗ %-10s MISSING\n" "$c"; done
  echo; echo "=== ~/.iris/ ==="; ls -la ~/.iris/ 2>&1
  echo; echo "=== Binary test ==="; ~/.iris/bin/iris --version 2>&1 || echo "EXIT: $?"
  echo; echo "=== AGENTS.md? ==="; ls -la ~/.iris/AGENTS.md ~/.iris/how-to/ 2>&1
} 2>&1
```

## Failure mode 1: "End-of-central-directory signature not found" (unzip fails)

```
[.../iris-darwin-x64-baseline.zip] 100%
End-of-central-directory signature not found.
unzip: cannot find zipfile directory...
```

**Cause:** The installer asked for `iris-darwin-x64-baseline.zip` but no baseline build exists in the GitHub release. GitHub returned a 16KB HTML 404 page, installer saved it as `.zip`, unzip choked.

**Why it happens:** The installer detects the CPU lacks AVX2 (or the sysctl key returns a false negative on older macOS) and appends `-baseline` to the filename. If the release doesn't publish baseline artifacts, the download silently fails.

**Fix (already shipped in v1.1.16+):** The installer now HEAD-probes the baseline URL before downloading. If 404, it falls back to the standard build with a warning. Also checks BOTH `hw.optional.avx2_0` AND `hw.optional.avx2` sysctl keys.

**Manual workaround (for users on old installer):**
```bash
# Re-run the install (the fix is in the live install script):
curl -fsSL https://heyiris.io/install-code | bash
```

## Failure mode 2: "dyld: cannot load 'iris' (load command 0x80000034 is unknown)"

```
dyld: cannot load 'iris' (load command 0x80000034 is unknown)
Abort trap: 6
```

**Cause:** The user's macOS is older than 12 (Monterey). Load command `0x80000034` is `LC_DYLD_CHAINED_FIXUPS`, introduced in macOS 12. The Bun-compiled binary uses this for faster startup. Older macOS versions physically cannot load the binary.

**Diagnosis:** Run `sw_vers -productVersion`. If it returns 11.x or lower, this is the issue.

**Fix:** User must upgrade to macOS 12+ (if their Mac supports it), or use a cloud VM / different machine. There is no binary-side workaround — Bun itself requires macOS 10.15+ and the chained fixups require 12+.

**Already shipped (v1.1.16+):** The installer now detects macOS < 12 at pre-flight and prints a clear warning BEFORE downloading the binary.

**Mac hardware compatibility:**
- 2015+ MacBooks → can upgrade to Monterey (12) ✓
- 2013-2014 MacBooks → max Big Sur (11) ✗
- 2012 and earlier → max High Sierra (10.13) ✗

## Failure mode 3: Missing system dependencies (unzip, jq, etc.)

```
Error: 'unzip' is required but not installed.
```

**Cause:** Fresh Mac without Xcode Command Line Tools, or minimal Linux without common utilities.

**Fix (already shipped):** The installer now has a "soft pre-flight" that auto-installs `unzip` via brew or apt when missing. If brew isn't present either, it prints the exact one-liner to install Homebrew first.

**Manual workaround:**
```bash
# Install Homebrew first (if missing):
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Then install deps:
brew install unzip jq git
# Then re-run IRIS install:
curl -fsSL https://heyiris.io/install-code | bash
```

**Or use iris-deps (if IRIS is already installed):**
```bash
iris-deps unzip jq git     # install specific deps
iris-deps all               # install full ecosystem
```

## Failure mode 4: Scaffold fetch fails (GitHub raw 404)

```
[4b]  IRIS Docs .......................... fetch failed
      Writing embedded fallback AGENTS.md
```

**Cause:** The scaffold files aren't on the expected GitHub raw URL, or there's a network issue. The installer falls back to an embedded minimal AGENTS.md.

**Fix:** The embedded fallback is intentional — it means the install completes but without how-to recipes. User can re-fetch later:
```bash
curl -fsSL https://heyiris.io/install-code | bash -s -- --only-docs
```

**If this persists:** Check that `https://raw.githubusercontent.com/FREELABEL/iris-opencode/main/scaffold/manifest.json` returns valid JSON. If 404, the scaffold directory hasn't been pushed to the iris-opencode main branch.

## Failure mode 5: "IRIS Code" branding (cosmetic, fixed)

**Symptom:** Install completion banner shows "IRIS CODE" ASCII art and "IRIS Code includes free AI models" instead of "IRIS CLI".

**Cause:** User installed before the rebrand commit landed.

**Fix:** `iris update` pulls the latest binary with correct "IRIS CLI" branding everywhere.

## How the install-code endpoint works (architecture)

```
curl -fsSL https://heyiris.io/install-code | bash
  │
  ▼
iris-api routes/web.php:24 → redirect to config('services.iris.install_script_url')
  │
  ▼
Default: https://raw.githubusercontent.com/FREELABEL/iris-opencode/main/install
  │
  ▼
GitHub raw serves the file straight from the git tree on main
  │
  ▼
No build step, no cache, no CDN delay — git push = live in ~5 seconds
```

**To update the install script:** Just push to `FREELABEL/iris-opencode/main`. The install script at `heyiris.io/install-code` updates instantly because it's a redirect to GitHub raw.

## Related recipes

- `iris-login.md` — what to do AFTER install succeeds
- `hive-dispatch.md` — requires a working binary (check this guide first if dispatch fails)
