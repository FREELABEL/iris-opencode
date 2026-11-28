/**
 * English for the dead ends turned into buttons (#194583): Drives, Hive, Heartbeats, Artifacts,
 * Brand kits, the playbook flow, the card editor and the Browser fallback. See packages/ui/AGENTS.md.
 */
export const IRIS_DEAD_ENDS_ENGLISH = {
  // Drives › signed out
  "iris.drives.signIn.title": "Sign in to see your drives",
  "iris.drives.signIn.body": "Your drive catalogue lives in your IRIS account. Sign in, and your drives show up here.",
  "iris.drives.signIn.action": "Sign in",
  "iris.drives.signIn.elsewhere":
    "Your drive catalogue lives in your IRIS account. Sign in from the IRIS desktop app on this computer, then check again.",
  "iris.drives.signIn.check": "Check again",

  // Hive › Machines
  "iris.hive.add.enroll": "Add it to Hive",
  "iris.hive.add.doctor": "Check the chain",
  "iris.hive.add.copy": "Copy",
  "iris.hive.add.copied": "Copied",
  "iris.hive.machines.empty.title": "No computers in Hive yet",
  "iris.hive.machines.empty.body":
    "Add a computer and it shows up here: whether it is online, what it can do, and what is running on it. Then you can send it work.",
  "iris.hive.machines.empty.action": "Add a computer",

  // Hive › Inbox
  "iris.hive.inbox.reconnect": "Reconnect",
  "iris.hive.inbox.reconnect.describe":
    "Restarts IRIS's background service on this computer and brings it back online in Hive, so the inbox can be read again.",
  "iris.hive.inbox.you": "You: {{text}}",

  // Agents › Heartbeats
  "iris.heartbeats.empty.title": "No agent has a heartbeat yet",
  "iris.heartbeats.empty.body":
    "A heartbeat wakes an agent on a schedule so it works on its own: it checks its boards, acts, and reports. Pick an agent and give it one.",
  "iris.heartbeats.empty.action": "Choose an agent",
  "iris.heartbeats.noMatch": "Nothing matches “{{q}}”",
  "iris.heartbeats.autonomous": "Make autonomous",
  "iris.heartbeats.autonomous.describe":
    "{{name}} will act on its own at each beat — doing the work it finds, not only watching and reporting. You can switch it back in the agent's settings.",

  // Playbooks › Run it
  "iris.playbook.run.describe":
    "Runs the {{name}} playbook on this computer, step by step, as you. A step that needs a person stops the run and says what it is waiting for.",
  "iris.playbook.run.describeArgs":
    "Runs the {{name}} playbook on this computer, as you. It needs some values: add them to the line (for example --name value), then run it.",
  "iris.playbook.run.ok": "It ran. The dialog has what it printed.",
  "iris.playbook.run.failed": "It stopped with an error (exit {{code}}). The dialog has what it printed.",
  "iris.playbook.run.timedOut": "It was still running when the time limit was reached, so it was stopped. The dialog has what it printed up to then.",

  // Atlas card › Sharing › agent
  "iris.card.agent.head": "Work on it with an agent",
  "iris.card.agent.body": "IRIS reads the card as it is now and does the work it describes, in this chat.",
  "iris.card.agent.bodyNoChat": "Open the card beside a chat to hand it to IRIS. For an agent somewhere else, copy the line below.",
  "iris.card.agent.action": "Work on it in this chat",
  "iris.card.agent.prompt": "Work on the Atlas card “{{title}}”. Read it first with `{{command}}`, do the work it describes, then say on the card what you did.",

  // Genesis › Pages
  "iris.pages.side.dev": "For developers",

  // IRIS › Browser, when its pane did not load
  "iris.browser.missing.title": "The Browser didn't load in this window",
  "iris.browser.missing.body":
    "The Browser runs in IRIS's side panel and loads with the window. Reload IRIS to load it again. If it is still missing, open a chat and choose Browser from its side panel.",
  "iris.browser.missing.action": "Reload IRIS",

  // Artifacts history (Genesis › Artifacts and Atlas › Artifacts)
  "iris.artifacts.history.label": "Artifacts, newest first",
  "iris.artifacts.history.loading": "Reading artifacts…",
  "iris.artifacts.history.open": "Open {{title}}",
  "iris.artifacts.history.openShort": "Open",
  "iris.artifacts.history.publish": "Publish",
  "iris.artifacts.history.share": "Copy link",
  "iris.artifacts.history.shared": "Link copied",
  "iris.artifacts.history.scope": "Show",
  "iris.artifacts.history.thisChat": "This chat",
  "iris.artifacts.history.allChats": "All chats",
  "iris.artifacts.history.here": "this chat",
  "iris.artifacts.history.elsewhere": "another chat",
  "iris.artifacts.history.noneHere": "Nothing made in this chat yet. Here is everything made in this project.",
  "iris.artifacts.history.noChat": "Everything made in this project, newest first. Open one, or open a chat to make more.",
  "iris.artifacts.empty.title": "Nothing made here yet",
  "iris.artifacts.empty.body":
    "When an agent makes a page, a brief or a table, it shows up here with who made it, from every chat in this project. Ask in the chat: “make me a landing page for …”.",
  "iris.artifacts.kind.html": "Page",
  "iris.artifacts.kind.markdown": "Document",
  "iris.artifacts.kind.csv": "Table",
  "iris.artifacts.kind.code": "Code",
  "iris.artifacts.kind.note": "Atlas note",
  "iris.artifacts.kind.file": "File",
  "iris.artifacts.status.draft": "Draft",
  "iris.artifacts.status.behind": "Page is behind",
  "iris.artifacts.status.public": "Public",
  "iris.artifacts.status.unlisted": "Unlisted",
  "iris.artifacts.status.private": "Private",
  "iris.artifacts.status.notPublic": "Not public",
  "iris.artifacts.status.live": "Live",

  // Atlas › Artifacts
  "iris.atlasNotes.list": "All notes",
  "iris.atlasNotes.sharedInChat": "shared in chat",
  "iris.atlasNotes.publishedHere": "published from this chat",
  "iris.atlasNotes.empty.title": "No Atlas notes in this chat yet",
  "iris.atlasNotes.empty.body":
    "When your agent publishes or shares an Atlas note here — a plan, an epic, a brief — it opens in this pane, live, with its link. Ask in the chat: “write this up as an Atlas note”.",
  "iris.atlasNotes.noChat.title": "Open a chat to see its Atlas notes",
  "iris.atlasNotes.noChat.body": "Atlas notes belong to the chat that made them. Open one from the sidebar, or start a new one.",
}
