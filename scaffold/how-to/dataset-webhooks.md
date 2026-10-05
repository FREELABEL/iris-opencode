---
category: Data
level: intermediate
tags: [atlas, datasets, webhooks, hooks, events, records, signed, hmac, integration, automation, backend]
duration_min: 10
---
# How to: Get a webhook when a dataset record changes

## What this does

When a record in one of your datasets is created, updated or deleted, IRIS POSTs a signed
payload to a URL you choose — so "when a lead lands, do X" no longer needs a poller.

## Steps

**1. Add a hook**

```bash
iris datasets hooks add leads --url https://example.com/iris-hook --on created,updated
```

The signing secret is shown **once**. Save it. The URL must be `https`, and must resolve to a
public address.

**2. Check deliveries**

```bash
iris datasets hooks list leads
iris datasets hooks deliveries leads --json
```

Every attempt is recorded with its status code and timing. Failures retry for about 8 hours
(1m, 5m, 30m, 2h, 6h).

**3. Verify the signature in your receiver**

Headers: `X-Atlas-Signature: t=<timestamp>,v1=<hex>`, `X-Atlas-Timestamp`, `X-Atlas-Event`,
`X-Atlas-Delivery` (the same id across retries — use it to dedupe).

`v1` is `HMAC-SHA256(secret, timestamp + "." + raw_body)` in hex. Reject anything older than
5 minutes.

```js
const [t, v1] = sig.split(",").map((p) => p.split("=")[1])
const ok = Math.abs(Date.now() / 1000 - Number(t)) < 300 &&
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")))
```

## Patient data

Fields marked PHI are left out of payloads (listed in `omitted_fields`). `--phi-cleared`
includes them only if the destination is a provider with a BAA in the PHI egress registry.

```bash
iris datasets hooks remove leads 7      # hook id from `hooks list`
```
