/**
 * Which update to install when someone clicks Restart (#190091): the one already downloaded, or a
 * newer one the feed names now. A person on A while D is out goes straight to D — never B, C, D.
 * Never steps backwards; an unreadable feed means "install what we have".
 */
export function newestToInstall(pending: string, latest: string | undefined): "pending" | "latest" {
  if (!latest || latest === pending) return "pending"
  return compare(latest, pending) > 0 ? "latest" : "pending"
}

function compare(a: string, b: string) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
