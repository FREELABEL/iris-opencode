---
category: CRM & Sales
level: beginner
tags: [pulse, desktop, topic, contact, follow-up, crm]
duration_min: 5
---
# How to: Pulse a topic or a contact in IRIS Desktop

## What this does
Pulse in IRIS Desktop answers two questions without leaving your chat:

- **Topic:** "Where does this stand?" Name a client, a project or a feature, and Pulse follows
  every trail it left: commits, your diary, files, agent sessions, tasks, checks and mail. It
  shows each stop as it reads it.
- **Contact:** "What do I owe this person?" Find a contact, and Pulse reads their record, their
  score and their recent mail. It lists what is owed, most urgent first.

It only reads. Nothing is filed, saved or sent from the panel.

For scoring your whole book of accounts and the daily email, see the `pulse` how-to.

## Prerequisites
- IRIS Desktop 1.18.117 or later. It updates itself; restart the app if it hasn't yet. The
  `/pulse` shortcut and the pinned tab arrive in the release after 1.18.117.
- Signed in to IRIS. The contact search reads your CRM.
- Optional, for the mail stops: Gmail connected (**+** menu → **Integrations**), or Apple Mail on a Mac.

## 1. Open Pulse
In any chat, type **/pulse** and press **Enter**. Or click the **Pulse** tab at the top of the
side panel. If you don't see that tab, click **+** there and choose **Pulse**.

## 2. Pulse a topic
1. Choose **Topic**.
2. Type what you want to check in the "a client, a project, a feature…" box, then press
   **Enter** or click **Drive the route**.
3. The route fills in stop by stop: your commits, diary, files, Claude Code and opencode
   sessions, iMessage, Mail, Gmail and Atlas. A pin pulses while its stop is being read, and
   each stop says what it found, or why it could not get in.
4. Click a stop to see exactly what it picked up.
5. Choose **7d**, **30d** or **90d** to look closer in or further back. Click **Run again** to
   read the route fresh.

## 3. Pulse a contact
1. Choose **Contact**.
2. Search by name, email or company, then pick the person.
3. The top line shows their score and trend. **What is owed** lists the replies and tasks
   waiting on you, numbered by urgency. The numbers match the pins on the route.
4. Click any stop to see what it found.

## Gotchas

**"The route did not finish."** One of the stops could not be read: the app was offline, or an
account is disconnected. Click **Try again**. If one mail stop keeps failing, reconnect it from
**Integrations**.

**A topic finds nothing.** Pulse matches the words you typed. Try the client's name instead
of a nickname, or a word that appears in your commits or diary.

**One stop takes much longer than the rest.** The topic route reads stops in order, and Diary
is usually the slowest. The other stops still appear as soon as each is read.

**The contact you want isn't listed.** Contacts are your CRM leads. Add them with
`iris leads create`, then search again.
