---
category: Infrastructure
level: beginner
tags: [mailjet, email, newsletter, integrations, contact list, send email]
duration_min: 10
prerequisites: [iris-integrations]
---
# Send email through your own Mailjet account

Connect your Mailjet account once, then build contact lists and send email from the CLI, from
workflows and from agents. Everything runs on **your** Mailjet key pair: your sender, your
lists, your sending limits.

## 1. Connect

In Mailjet, open **Account Settings → API Key Management** and copy the API key and the secret
key. Then:

```bash
iris integrations connect mailjet --field api_key=<API_KEY> --field api_secret=<SECRET_KEY>
```

Type this yourself, in your own terminal. Don't paste the secret into a chat with an agent.

## 2. Check it works

```bash
iris integrations exec mailjet get_contact_lists
```

A list of your Mailjet contact lists (or an empty list) means it works. If it says Mailjet
"did not accept the API key/secret pair", one half is wrong: check both at
https://app.mailjet.com/account/apikeys and run `connect` again.

> `iris integrations test mailjet` and `iris integrations health` only report Mailjet correctly
> from v1.3.345 on. On an older CLI, use the `exec` command above to check the connection.

## Dry run first, --apply to do it

Reads (`get_*`) run straight away. Anything that writes or sends (`send_*`, `create_*`, `add_*`,
`update_*`, `delete_*`) is a **dry run unless you add `--apply`**. A dry run prints the connection it
would use, the parameters (long bodies cut short) and how many recipients it would reach, sends
nothing, and exits 0. With `--json` it prints `{"dry_run": true, "executed": false, …}`.

```bash
iris integrations exec mailjet send_transactional_email --integration-id <ID> --params-file msg.json          # preview
iris integrations exec mailjet send_transactional_email --integration-id <ID> --params-file msg.json --apply  # send
```

A script that sends in a loop must pass `--apply` on every call, and should check that each result
has a message id: a call without it is a preview, not a send. CLI versions before this change could
send without `--apply` — upgrade (`iris update`) before relying on the preview.

## 3. Build a list

```bash
iris integrations exec mailjet create_contact_list name="NCMA Members" --apply
iris integrations exec mailjet add_contact_to_list list_id=<LIST_ID> email=jane@example.com name="Jane Doe" --apply
```

Adding a contact never re-subscribes someone who unsubscribed. For many contacts, call
`add_contact_to_list` once per person. There is no bulk import through IRIS yet.

## 4. Send

One email, now:

```bash
iris integrations exec mailjet send_transactional_email --integration-id <ID> \
  to=jane@example.com subject="Chapter update" \
  html_body="<p>Hello</p>" from_email=you@yourdomain.com from_name="NCMA Fort Worth" --apply
```

`from_email` must be a sender your Mailjet account has validated. You can leave it out when a
sender is saved on the connection — the send then uses that one. With neither, the send is refused
and nothing goes out; IRIS never invents a sender. An operator saves (or shows) the sender with:

```bash
php artisan integrations:mailjet-sender <integration-id> you@yourdomain.com --name="NCMA Fort Worth"
php artisan integrations:mailjet-sender <integration-id>          # show what is saved
```

Pass `--integration-id` when you can see more than one Mailjet connection (your own, or ones shared
with your boards), so the email goes out through the account you mean.

A campaign to a list:

```bash
iris integrations exec mailjet create_campaign \
  list_id=<LIST_ID> subject="October newsletter" from_email=you@yourdomain.com \
  from_name="NCMA Fort Worth" html_content="<p>…</p>" --apply
```

`create_campaign` creates a **draft** in Mailjet. It never sends. Review the draft in Mailjet and
send it from there.

## Everything you can call

Lists: `get_contact_lists`, `create_contact_list`, `add_contact_to_list`.
Email: `send_transactional_email`, `send_email_with_template`.
Campaigns and templates: `create_campaign` (draft only), `get_campaigns`, `create_template`,
`get_templates`, `update_template_content`, `delete_template`.
Statistics: campaign, API key, link click, mailbox provider, geography and contact statistics.

Use `-p '{"key":"value"}'` or `--params-file params.json` instead of `key=value` when a value is
long, such as an HTML body.

## Sharing it with your team

A connection belongs to the person who made it. To let a board's agents and teammates use it:

```bash
iris integrations share <integration-id> <bloq-id>
```

See `iris how-to view integration-tenancy`.
