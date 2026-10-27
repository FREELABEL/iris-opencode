---
category: Automation
level: beginner
tags: [playbooks, schedule, daily, email, automation, hive]
duration_min: 10
---
# How to: Run a playbook every morning (and email the result)

## What this does

Takes a playbook you can already run by hand, like `meal-plan-day`, and runs it on a schedule on
a machine you choose: every day at 6:00, every weekday, every week. If the playbook sends an
email, it can go out from IRIS itself, so no computer has to be awake for it to arrive.

You check the schedule once, when you make it. Every argument is checked against the playbook
before anything is saved, so a typo is caught now and not at 6 o'clock tomorrow.

## Before you start

- The playbook runs by hand: `iris playbook run <name>` finishes with ✓ completed.
- The machine that will run it is connected to your Hive and online: `iris hive nodes list`.
  An always-on machine is best. If it's a laptop, the schedule only runs while it's awake.

## Step 1: Run it once by hand, exactly as the schedule will

Give every value a name. The schedule stores exactly these:

```bash
iris playbook run meal-plan-day board="Jordan — Life Atlas" person=Jordan email=preview
```

`email=preview` shows the message that would be sent and sends nothing. Read it.

## Step 2: Make the schedule

The same values, plus when:

```bash
iris playbook schedule meal-plan-day board="Jordan — Life Atlas" person=Jordan \
  action=write email=send email_to=jordan@example.com \
  --at 06:00 --tz America/New_York
```

It runs on this machine unless you say `--node <name>`. Add `--dry-run` to check everything and
save nothing. Other rhythms: `--every weekdays`, `--every weekly`, `--every every_6_hours`.

If something is wrong, nothing is saved and you're told why:

```
Unknown argument: emial
Did you mean: emial → email
```

## Step 3: See what's scheduled and how it went

```bash
iris playbook schedules            # every scheduled playbook, its next run, how the last one went
iris schedules history <id>        # each run's output
iris schedules run <id>            # run it now, without waiting for tomorrow
iris schedules toggle <id>         # pause it, and run it again to resume
```

## Sending one message to one person yourself

A playbook that emails someone uses this, and you can too:

```bash
iris email message --to jordan@example.com --subject "Today's meals" \
  --text-file plan.txt --bloq <board id> --provider mailjet --from team@yourdomain.com --test
```

Write the message as plain text and IRIS makes a version that reads well on a phone. `--test`
puts `[TEST]` in the subject line; leave it off to send for real. Follow delivery with
`iris email status <run id> --refresh`.

## If something goes wrong

| What you see | What to do |
|---|---|
| `"office-mac" is offline — a schedule pinned to it would never run` | Start IRIS on that machine, or pick another with `--node`. |
| `Say which machine runs it: --node <name>` | This machine isn't on your Hive. Pass the machine that should run it. |
| `Give each value a name` | Write `name=value`, not a bare value. |
| A run shows **failed** in `iris playbook schedules` | `iris schedules history <id>` shows the playbook's own error. |
| The email didn't arrive | `iris email status <run id> --refresh`. "Accepted" means the provider took it, not that it reached the inbox. |
