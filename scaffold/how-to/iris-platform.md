# IRIS Platform — Connect Any Frontend to IRIS as Its Backend

Use IRIS as a complete backend-as-a-service for any React, Vue, or mobile app. Zero server code. Your client's frontend calls IRIS APIs on a staging subdomain — same domain, no CORS.

## What the client gets

| Capability | Endpoint | Replaces |
|-----------|----------|----------|
| Database (CRUD) | `/api/v1/public/bloqs/{id}/items` | Firebase / Supabase |
| AI Chat | `/api/v6/chat/stream` | OpenAI / Google AI Studio |
| Payments | `/api/v1/events/{id}/tickets/{id}/checkout` | Custom Stripe |
| Lead CRM | `/api/v1/public/form/submissions` | HubSpot |
| Events + QR | `/api/v1/events/*` | Eventbrite |
| Pages | `/api/v1/pages/*` | Webflow |
| Compute | `/api/v6/nodes/tasks` | AWS Lambda |
| Staging URL | `clientapp.heyiris.io` | Vercel Preview |

## Quick Start

### 1. Create workspace + data store

```bash
iris bloqs create "ClientApp" --description "Client's app data"
# Save the bloq_id

# Create data lists (like database tables)
iris bloqs create-list {bloqId} "Users"
iris bloqs create-list {bloqId} "Products"
iris bloqs create-list {bloqId} "Orders"
```

### 2. Create AI agent

```bash
iris agents create \
  --name "ClientApp AI" \
  --model gpt-4o-mini \
  --bloq {bloqId} \
  --system-prompt "You are a helpful assistant for ClientApp."
```

### 3. Set up staging subdomain

**If client has no app yet** — serve a Genesis landing page:
```bash
iris pages create client-landing "ClientApp"
iris pages publish client-landing
# Then create domain mapping with mapping_mode='page'
```

**If client has an existing app** (React on Cloud Run, Vercel, etc.):
```bash
# 1. Add domain mapping to DB:
#    domain: clientapp.heyiris.io
#    mapping_type: proxy
#    mapping_mode: proxy
#    proxy_target: https://their-app.run.app
#    status: active

# 2. Add Cloudflare Worker route:
#    Pattern: *clientapp.heyiris.io/*
#    Worker: iris-domain-proxy
#    Failure mode: Fail open
```

### 4. Wire the frontend

```javascript
const IRIS_API = 'https://clientapp.heyiris.io'  // same domain = no CORS
const SDK_KEY = process.env.REACT_APP_IRIS_SDK_KEY

// AI Chat (replaces Google AI Studio / OpenAI)
const res = await fetch(`${IRIS_API}/api/v6/chat/stream`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: AGENT_ID, message: 'Hello' })
})

// Read data (replaces Firebase reads)
const items = await fetch(
  `${IRIS_API}/api/v1/public/bloqs/${BLOQ_ID}/items?list=Products`,
  { headers: { 'Authorization': `Bearer ${SDK_KEY}` } }
).then(r => r.json())

// Write data (replaces Firebase writes)
await fetch(`${IRIS_API}/api/v1/public/bloqs/${BLOQ_ID}/items`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Widget', content: '{"price": 29.99}', type: 'default' })
})

// Dispatch background compute (replaces Lambda)
await fetch(`${IRIS_API}/api/v6/nodes/tasks`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_id: USER_ID,
    type: 'custom',
    prompt: 'process uploaded file',
    config: { callback_url: 'https://clientapp.heyiris.io/api/webhook/result' }
  })
})
```

### 5. Lead capture (no auth needed)

```html
<form action="https://clientapp.heyiris.io/api/v1/public/form/submissions" method="POST">
  <input name="email" type="email" required />
  <input name="name" type="text" />
  <button type="submit">Join Waitlist</button>
</form>
```

## How it works

```
clientapp.heyiris.io
       │
       │  Cloudflare Worker (iris-domain-proxy)
       │  Sets X-Original-Host, forwards to Railway
       ▼
┌─ iris-api ───────────────────────────────────┐
│                                               │
│  /api/*  →  iris-api handles directly         │
│             (AI chat, bloqs, events, tools)    │
│                                               │
│  /*      →  StagingProxyController             │
│             reverse-proxies to client's app    │
│             (Cloud Run, Vercel, Netlify, etc.) │
└───────────────────────────────────────────────┘
```

## Bloq CRUD cheat sheet

```bash
# List items
curl https://clientapp.heyiris.io/api/v1/public/bloqs/{bloqId}/items \
  -H "Authorization: Bearer {SDK_KEY}"

# Filter by list
curl ".../items?list=Products"

# Create
curl -X POST ".../items" \
  -H "Content-Type: application/json" \
  -d '{"title":"Widget","content":"{\"price\":29.99}","type":"default"}'

# Update
curl -X PUT ".../items/{itemId}" \
  -d '{"title":"Updated Widget"}'

# Delete
curl -X DELETE ".../items/{itemId}"
```

**Note:** `type` is required on create. Use `"default"` unless you have custom types.

## New client checklist

- [ ] Create bloq: `iris bloqs create "AppName"`
- [ ] Create lists: `iris bloqs create-list {id} "TableName"`
- [ ] Create agent: `iris agents create --name "AppName AI" --bloq {id}`
- [ ] Add domain mapping in DB (proxy or page mode)
- [ ] Add Cloudflare Worker route for subdomain
- [ ] Give client SDK key
- [ ] Test health: `curl https://subdomain.heyiris.io/api/health`
- [ ] Test proxy: `curl https://subdomain.heyiris.io/`
- [ ] Test CRUD: `curl https://subdomain.heyiris.io/api/v1/public/bloqs/{id}/items`

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Application not found" | Worker route missing | Add `*subdomain.heyiris.io/*` in Cloudflare |
| HTML loads, JS/CSS 404 | Old deploy without catch-all route | Redeploy iris-api |
| CRUD returns 422 | Missing `type` field | Add `"type": "default"` to POST body |
| Stale proxy target | 5-min domain mapping cache | Wait 5 min or clear cache |
| CORS errors | App on different domain | Use staging subdomain (same domain = no CORS) |

## Pricing

| | Price | Includes |
|-|-------|---------|
| Starter | $99 onboard | 1 bloq, 1 agent, staging URL |
| Pro | $99 + $29/mo | 5 bloqs, 5 agents, custom domain |
| Business | $99 + $79/mo | Unlimited, priority support |
