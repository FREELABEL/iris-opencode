// What a device shows before it has ever opened a project for a server (#194511).
//
// The sidebar's project list is kept per device (context/server.tsx). IRIS Desktop fills it as you
// open folders; a phone or a new browser pointed at the same engine starts with nothing, and since
// chats are listed per project, it showed "Nothing here yet" while the engine was returning every
// chat. So the folders of the server's most recent chats are added to the list on each launch.

export const SEED_PROJECT_LIMIT = 5

type SessionLike = { location?: { directory?: string }; time?: { created?: number; updated?: number } }

/** The folders of the most recent chats, newest first, each once, at most `max`; never "/". */
export function seedDirectories(sessions: SessionLike[], max = SEED_PROJECT_LIMIT) {
  const recency = (s: SessionLike) => s.time?.updated ?? s.time?.created ?? 0
  return [...new Set([...sessions].sort((a, b) => recency(b) - recency(a)).map((s) => s.location?.directory))]
    .filter((directory): directory is string => !!directory && directory !== "/")
    .slice(0, max)
}

/**
 * The recent folders this device does not list yet, minus any the person closed here. Not only for
 * an empty list: build 28 had a stray "Desktop" project, so "Work" (all 63 chats) never appeared.
 */
export function missingSeeds(seeds: string[], device: { listed: string[]; closed: string[] }) {
  const skip = new Set([...device.listed, ...device.closed])
  return seeds.filter((directory) => !skip.has(directory))
}
