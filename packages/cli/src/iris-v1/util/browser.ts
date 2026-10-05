/**
 * Open a URL in the user's browser without hanging the caller.
 *
 * Two bugs this exists to kill, both of which stranded an agent session on
 * Windows (#183523):
 *
 *  1. `start "https://…"` DOES NOT OPEN THE URL. `start` is a cmd.exe builtin
 *     whose FIRST quoted argument is the WINDOW TITLE. The old call opened an
 *     empty console window titled with the URL and went no further. The empty
 *     "" below is that title slot; the URL is the argument after it.
 *
 *  2. `execSync` BLOCKS. Three of the four copies of this helper used it, so
 *     the CLI waited on the browser process and never exited — and an agent
 *     running the command sat on "Thinking" forever with no error to report.
 *     Detached + unref'd means the browser outlives us and we return now.
 *
 * Arguments are passed as an array, never interpolated into a shell string, so
 * a URL containing quotes or `&` cannot become a second command.
 */
export function openBrowser(url: string): boolean {
  try {
    const { spawn } = require("child_process")

    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          })

    child.unref()
    return true
  } catch {
    // Non-fatal — every caller prints the URL as well.
    return false
  }
}
