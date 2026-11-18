---
category: CRM & Sales
level: beginner
tags: [mailing, email, invitation, newsletter, mailjet, mass email, bulk email, send to a list, personalised email]
duration_min: 20
prerequisites: [mailjet]
---
# Send a personal email to everyone on a list

`iris mailing` sends one email per person, each with their own name in it, through **your own
Mailjet account**. You make a draft, send yourself a test, then send for real. Nothing goes out
until you say yes, and if anything stops half way you run the same command again to finish.

Works the same on Windows, Mac and Linux.

## 1. Connect Mailjet (once)

In Mailjet, open **Account Settings → API Key Management** and copy the API key and the secret
key. Then type this yourself, in your own terminal:

```bash
iris integrations connect mailjet --field api_key=<API_KEY> --field api_secret=<SECRET_KEY>
```

Don't paste the secret into a chat with an agent.

## 2. Make sure your sender address is approved (once)

Mailjet only sends from addresses you have approved. In Mailjet open **Account Settings →
Sender addresses & domains** and add the address you send from (for example
`you@yourdomain.com`). Mailjet emails that address a link; click it.

You tell IRIS which address to use when you make a draft, with `--from-email` and `--from-name`.
If you forget, the draft tells you how to add it.

## 3. Make a draft

You need two things:

- **The email** — an `.html` file, or the number of the Atlas item that holds it. Put
  `{{First Name}}` (or any column name from your list, in double braces) wherever a person's own
  details should go.
- **The list** — the number of your list in Atlas (for example `186974`), or a `.csv` file.
  Give each list a short name: `members=186974`.

```bash
iris mailing new --template invite.html \
  --subject "You're invited: Chapter Meeting, October 29" \
  --audience members=186974 \
  --from-email you@yourdomain.com --from-name "Your Name, Your Chapter" \
  --postal-address "123 Main St, Fort Worth, TX 76102"
```

It answers with a summary like:

```
Draft #12 — 101 members ready.
Dropped: 1 no email.
Preview — to jane@example.com
...
Next — send yourself a test:  iris mailing test 12
```

**Nothing has been sent.** Read the preview; the full version is saved as a file you can open in
your browser.

If it says some `{{…}}` blanks are left, a column name in the email does not match the list
(spelling and capitals count). Fix the email and run `iris mailing new` again.

### Two lists, kept separate

```bash
iris mailing new --template 189315 --subject "..." \
  --audience members=186974 --audience prospects=189317 \
  --skip-status "Email Status=Extrapolated,Unavailable" \
  --exclude someone@example.com \
  --personalize reason
```

- `--skip-status` holds back rows by a column's value — here, addresses a data vendor guessed
  rather than verified.
- `--exclude` leaves out specific addresses. Anyone on both lists gets it once.
- `--personalize reason` fills `{{Reason}}` with a line built from each person's title and
  company ("Given your role Contracts Manager at Acme, I thought this would be relevant.").

## 4. Send yourself a test

```bash
iris mailing test 12
```

It goes to your own address, marked **[TEST]**, filled in with the first person on the list.
To show someone else too: `iris mailing test 12 --to me --to colleague@example.com`.

Check it on your phone as well as your computer. Click every link.

## 5. Send

```bash
iris mailing send 12 --audience members
```

It shows the count and asks **Send to 101 people? (y/N)**. Only `y` sends. Then it shows progress
until it is done:

```
Sending…
  10:02:14  40 sent · 0 failed · 61 to go
  10:02:41  101 sent · 0 failed · 0 to go
Done — 101 sent, 0 failed.
```

Closing the window does not stop the send. To stop it: `iris mailing pause 12`.

Send a second list separately when you are ready: `iris mailing send 12 --audience prospects`.

**If it stops part way,** it tells you who failed and why. Run the same command again —
`iris mailing send 12` — and it carries on, skipping everyone already sent.

## 6. Check what happened

```bash
iris mailing status 12                         # counts and what to do next
iris mailing log 12                            # each person and what happened
iris mailing log 12 --csv --out sent.csv       # as a spreadsheet
iris mailing list                              # all your mailings
iris mailing discard 12                        # throw away a draft that sent nothing
```

Every command takes `--json` for scripts.

## Etiquette for lists that did not sign up

A list of members who joined your organisation is one thing. A list you bought or exported
(Apollo, ZoomInfo, a conference attendee sheet) is a **cold list**, and these rules keep your
Mailjet account in good standing:

- **Send to verified addresses only.** Hold back guessed ones with `--skip-status`. Bounces
  from guessed addresses are what get senders suspended.
- **One relevant email, not a sequence.** Say why you are writing to *them* — that is what
  `--personalize reason` is for — and invite them to opt in (join, register, reply).
- **Always a way out.** Every mailing carries an unsubscribe link and your postal address.
  Do not remove them; US law (CAN-SPAM) requires both.
- **Never re-add someone who unsubscribed.** IRIS skips them automatically.
- **Members first, cold list second, as two sends.** If the cold send bounces badly you see it
  on its own numbers, and your members' mail is already delivered.
- **Watch the log the next day.** Several hard bounces or a spam complaint means stop
  (`iris mailing pause`) and clean the list before sending more.

## When something goes wrong

| It says | Do this |
|---|---|
| Connect your Mailjet first | Step 1 |
| There is no sender address | Add `--from-email` and `--from-name` to `iris mailing new` (step 2–3) |
| The email still has blanks | A `{{Column}}` does not match the list; fix and make a new draft |
| Bulk email has to show a postal address | Add `--postal-address "..."` to `iris mailing new` |
| Not sent … no one here to confirm | You ran it from a script; add `--yes` once you are sure |
| Stopped part way | Run `iris mailing send <number>` again |

Related: `iris how-to view mailjet` (everything else Mailjet can do).
