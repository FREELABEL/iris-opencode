// What a device shows before it has ever opened a project for a server (#194511).
//
// The sidebar's project list is kept per device (context/server.tsx). IRIS Desktop fills it as you
// open folders; a phone or a new browser pointed at the same engine starts with nothing, and since
// chats are listed per project, it showed "Nothing here yet" while the engine was returning every
// chat. So an empty list starts from the folders of the server's most recent chats instead.

export const SEED_PROJECT_LIMIT = 5

type SessionLike = { location?: { directory?: string }; time?: { created?: number; updated?: number } }

/** The folders of the most recent chats, newest first, each once, at most `max`; never "/". */
export function seedDirectories(sessions: SessionLike[], max = SEED_PROJECT_LIMIT) {
  const recency = (s: SessionLike) => s.time?.updated ?? s.time?.created ?? 0
  return [...new Set([...sessions].sort((a, b) => recency(b) - recency(a)).map((s) => s.location?.directory))]
    .filter((directory): directory is string => !!directory && directory !== "/")
    .slice(0, max)
}

/** Only a list that is empty because nothing was ever opened here — not one the person emptied. */
export function shouldSeedProjects(input: { projects: number; recentlyClosed: number }) {
  return input.projects === 0 && input.recentlyClosed === 0
}
