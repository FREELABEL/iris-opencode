/**
 * What to tell someone whose daemon is missing (#186038, #185889).
 *
 * This used to be "Daemon not installed. Run: iris daemon install" everywhere. Two things were
 * wrong with that, both measured 2026-09-18 on a Pathways navigator's Windows machine:
 *
 *  - The usual reason the daemon is missing is that Node.js is missing — both installers skip
 *    the daemon without it. "Not installed" hides that, so the user reinstalls and lands in the
 *    same place (the loop #184597 fixed for `hive connect`, still open here).
 *  - `iris daemon install` fetched https://heyiris.io/install-daemon, which is a 404, and piped
 *    it to bash, which Windows does not have. The advice could not work on any machine.
 *
 * `iris node install` is the installer that works on every platform and names Node.js itself,
 * so that is what every message points at. Pure so the wording is testable without a Node-less
 * machine.
 */
export function missingDaemonAdvice(hasNode: boolean, os: NodeJS.Platform = process.platform): string[] {
  if (!hasNode) {
    const getNode = os === "win32"
      ? "https://nodejs.org (or in PowerShell: winget install OpenJS.NodeJS.LTS)"
      : os === "darwin"
        ? "https://nodejs.org (or: brew install node)"
        : "https://nodejs.org (or your package manager)"
    return [
      "Node.js is not installed, so the Hive daemon cannot run on this machine.",
      `Install Node.js from ${getNode}, then run: iris node install`,
    ]
  }
  return ["The Hive daemon is not installed on this machine.", "Install it: iris node install"]
}
