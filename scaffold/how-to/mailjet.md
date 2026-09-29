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

> Known gap: `iris integrations test mailjet` and `iris integrations health` do not report
> Mailjet correctly yet. Use the `exec` command above to check the connection.

## 3. Build a list

```bash
iris integrations exec mailjet create_contact_list name="NCMA Members"
iris integrations exec mailjet add_contact_to_list list_id=<LIST_ID> email=jane@example.com name="Jane Doe"
```

Adding a contact never re-subscribes someone who unsubscribed. For many contacts, call
`add_contact_to_list` once per person. There is no bulk import through IRIS yet.

## 4. Send

One email, now:

```bash
iris integrations exec mailjet send_transactional_email \
  to=jane@example.com subject="Chapter update" \
  html_body="<p>Hello</p>" from_email=you@yourdomain.com from_name="NCMA Fort Worth"
```

`from_email` is required, and it must be a sender your Mailjet account has validated. IRIS never
picks a sender for you.

A campaign to a list:

```bash
iris integrations exec mailjet create_campaign \
  list_id=<LIST_ID> subject="October newsletter" from_email=you@yourdomain.com \
  from_name="NCMA Fort Worth" html_content="<p>…</p>"
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
