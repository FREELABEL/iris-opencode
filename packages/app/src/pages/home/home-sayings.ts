/**
 * The line under the Home greeting ("Good evening, <saying>"). One per day, per user: each user
 * starts at their own place in the list and steps one forward each local day, so a user sees all of
 * them before any repeats, and two users on the same day usually see different ones. No server, no
 * storage — the same user on the same day always gets the same line.
 */
export const SAYINGS = [
  "here's your operation.",
  "here's what moved overnight.",
  "here's where things stand.",
  "let's see what's running.",
  "the machines kept working.",
  "here's the state of play.",
  "your agents have been busy.",
  "here's what needs you.",
  "here's the lay of the land.",
  "everything in one place.",
  "let's pick up where you left off.",
  "here's today, at a glance.",
  "the board is set.",
  "here's what changed.",
  "your operation, in one view.",
  "here's who's working.",
  "the hive is humming.",
  "here's what's on deck.",
  "let's get the important thing done.",
  "small steps, every day.",
  "here's the scoreboard.",
  "the work doesn't wait.",
  "here's the pulse.",
  "let's make it count.",
  "what you built is running.",
  "here's what ran while you were away.",
  "start with what's broken.",
  "one thing at a time.",
  "here's your daily brief.",
  "the numbers are in.",
  "here's what deserves attention.",
  "let's clear the deck.",
  "your crew checked in.",
  "here's where the time went.",
  "done is better than perfect.",
  "here's what's working.",
  "here's what's stuck.",
  "let's ship something.",
  "build the thing, then the next thing.",
  "the system is listening.",
  "here's your control room.",
  "let's keep it moving.",
  "every agent, every machine.",
  "here's your edge.",
  "quiet runs are good runs.",
  "green is good. red is a lead.",
  "let's look under the hood.",
  "here's the whole picture.",
  "nothing gets lost here.",
  "the receipts are in.",
  "make the next move.",
  "here's where you're needed.",
  "fewer tabs, more done.",
  "let the agents do the busywork.",
  "your future self says thanks.",
  "here's what's queued.",
  "one dashboard, no guessing.",
  "the heartbeat is steady.",
  "let's find the bottleneck.",
  "here's what shipped.",
  "progress over polish.",
  "the operation never sleeps.",
  "good systems beat good intentions.",
  "here's the signal, not the noise.",
  "let's tighten the loop.",
  "the work speaks for itself.",
  "here's your leverage.",
  "measure twice, run once.",
  "here's what's ready for you.",
  "automate the boring parts.",
  "let's turn plans into runs.",
  "here's the latest from the hive.",
  "your inbox can wait a minute.",
  "decide, then delegate.",
  "here's the shortlist.",
  "momentum is a strategy.",
  "let's check the vitals.",
  "here's what the machines saw.",
  "keep the main thing the main thing.",
  "here's what's in motion.",
  "a little better than yesterday.",
  "the pieces are in place.",
  "here's where to start.",
  "let's make today simple.",
  "trust the system, check the logs.",
  "here's what your team ran.",
  "less chasing, more building.",
  "the dashboard doesn't lie.",
  "here's what came back.",
  "let's close some loops.",
  "here's the operation, live.",
  "fix one thing, then ship it.",
  "the runs are on the record.",
  "here's what's worth your time.",
  "consistency compounds.",
  "your agents are on the clock.",
  "here's the map.",
  "let's raise the floor.",
  "everything accounted for.",
  "here's to a good run.",
] as const

/** A stable starting place per user: FNV-1a, then MurmurHash3's finalizer so sequential ids spread. */
function offsetOf(user: string) {
  let h = 2166136261
  for (let i = 0; i < user.length; i++) h = Math.imul(h ^ user.charCodeAt(i), 16777619)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % SAYINGS.length
}

/** The saying for `user` on the local calendar day of `date`. Without a user, everyone shares one. */
export function sayingFor(user: string | number | undefined, date: Date): string {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
  const offset = user === undefined ? 0 : offsetOf(String(user))
  return SAYINGS[(day + offset) % SAYINGS.length]
}
