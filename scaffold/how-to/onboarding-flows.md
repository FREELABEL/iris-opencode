# How to: Create Schema-Driven Onboarding Flows

Build multi-step onboarding wizards for any client using Atlas schemas. No code required — just define schemas and configure the flow.

## Overview

Onboarding flows are powered by the IRIS Onboard SDK. A flow is an `atlas_schema` with `settings.flow_type = 'onboarding'`. Child schemas define the fields for each step. The `OnboardingFlow` Genesis component renders the wizard on any page.

## Quick Start (5 minutes)

### 1. Create child schemas (the form steps)

```bash
# Create a schema for each step of your onboarding
iris atlas schemas create --slug my-contact-info --name "Contact Information"
iris atlas schemas create --slug my-preferences --name "Your Preferences"
```

Or via API:
```bash
curl -X POST https://raichu.heyiris.io/api/v1/atlas/schemas \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-contact-info",
    "name": "Contact Information",
    "fields": {
      "display_field": "email",
      "fields": [
        {"key": "name", "label": "Full Name", "type": "text", "required": true, "placeholder": "Jane Doe"},
        {"key": "email", "label": "Email", "type": "email", "required": true},
        {"key": "phone", "label": "Phone", "type": "phone", "required": false},
        {"key": "address", "label": "Address", "type": "address", "placeholder": "Start typing..."}
      ]
    }
  }'
```

### 2. Create the flow schema (the orchestrator)

```bash
curl -X POST https://raichu.heyiris.io/api/v1/atlas/schemas \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-onboarding",
    "name": "My Onboarding",
    "fields": {"fields": []},
    "settings": {
      "flow_type": "onboarding",
      "status": "active",
      "steps": [
        {"type": "schema", "schema_slug": "my-contact-info", "title": "About You", "description": "Tell us about yourself"},
        {"type": "schema", "schema_slug": "my-preferences", "title": "Preferences"},
        {"type": "completion", "title": "All Done!", "message": "Welcome aboard!"}
      ],
      "branding": {"accent_color": "#3b82f6"},
      "completion": {"create_lead": true},
      "analytics": {"started_count": 0, "completed_count": 0}
    }
  }'
```

### 3. Add to a Genesis page

```bash
iris pages set my-page "components[+]" '{
  "type": "OnboardingFlow",
  "id": "onboarding-1",
  "props": {"flowSlug": "my-onboarding", "themeMode": "light"}
}'
```

Or get the embed snippet:
```bash
iris onboard-flows embed my-onboarding
```

### 4. Test it

```bash
iris onboard-flows view my-onboarding   # Check config
iris onboard-flows test my-onboarding   # Get test URL
```

## Field Types

| Type | Renders As | Notes |
|------|-----------|-------|
| `text` | Text input | Auto-detects textarea for keys containing "note", "description", "history" |
| `email` | Email input | HTML5 email validation |
| `phone` | Phone input | Auto-formats to (555) 123-4567 as you type |
| `number` | Number input | |
| `date` | Date picker | |
| `enum` | Dropdown OR card picker | Card picker auto-activates for single-enum steps with 4+ options |
| `checkboxes` | Checkbox grid (2-col) | Value is an array of selected values |
| `address` | Autocomplete input | Uses Geoapify API. Requires `geoapifyApiKey` prop on component |
| `boolean` | Checkbox | |

## Step Types

| Type | Purpose |
|------|---------|
| `welcome` | HTML content (intro screen). Uses `content` field for HTML. |
| `schema` | Form step. References a child schema via `schema_slug`. |
| `payment` | Payment selection (placeholder — uses PaymentGateService). |
| `contract` | Contract/waiver signing (placeholder). |
| `completion` | Final step. Shows `message` field. Can redirect via `redirect_url`. |

## Advanced Features

### Repeatable Steps (e.g., "Add another horse")

```json
{
  "type": "schema",
  "schema_slug": "my-horse",
  "title": "Your Horses",
  "repeatable": true,
  "min": 1,
  "max": 20
}
```

Users see "Add another" button and "Remove" per entry. Min/max enforced.

### Conditional Logic (show/hide steps by role)

```json
"conditional_logic": [
  {
    "if": {"field": "my-role-schema.role", "equals": "rider"},
    "hide_steps": ["my-barn-info", "my-staff-info"]
  },
  {
    "if": {"field": "my-role-schema.role", "equals": "barn_owner"},
    "hide_steps": ["my-horse-cards"]
  }
]
```

The `field` format is `schema_slug.field_key`. Steps are referenced by their `schema_slug`.

### Role Card Picker

When a step has exactly 1 enum field with 4+ options, it auto-renders as a clickable card grid (pastel colors, icons) instead of a dropdown. Perfect for role selection screens.

### Address Autocomplete

Set `type: "address"` on a field and pass `geoapifyApiKey` as a component prop:

```json
{"type": "OnboardingFlow", "props": {"flowSlug": "...", "geoapifyApiKey": "28191f41a97b406aa46b5c693fad11fe"}}
```

### Branding

```json
"branding": {
  "accent_color": "#065f46",
  "logo_url": "https://example.com/logo.svg"
}
```

Logo renders centered above the progress bar. Accent color applies to buttons, progress dots, and links.

### Completion Actions

```json
"completion": {
  "create_lead": true,
  "enroll_program": "program-slug",
  "payment": {"enabled": true, "package_ids": [1, 2, 3]}
}
```

On completion, the system can:
- Create a `SomLead` from submitted contact fields
- Enroll the user in a program
- Create a payment gate via Stripe

### Help Text

Add `helpText` to any field definition:
```json
{"key": "height", "label": "Height", "type": "text", "helpText": "Format: 14.3 h"}
```

Renders as small gray text below the input.

## CLI Commands

```bash
iris onboard-flows list                    # List all onboarding flows
iris onboard-flows view <slug>             # View flow config + steps
iris onboard-flows analytics <slug>        # Started/completed/conversion
iris onboard-flows test <slug>             # Get test URL
iris onboard-flows embed <slug>            # Generate page component JSON
iris onboard-flows create                  # Guided creation instructions
```

## API Endpoints

### Public (no auth, rate-limited)
```
GET  /api/v1/onboarding/flows/{slug}                    — Flow config + resolved fields
POST /api/v1/onboarding/sessions                        — Start session
PUT  /api/v1/onboarding/sessions/{token}/steps/{index}  — Submit step data
POST /api/v1/onboarding/sessions/{token}/complete        — Complete session
```

### Authenticated
```
GET  /api/v1/onboarding/flows                           — List flows (filter by bloq_id)
GET  /api/v1/onboarding/flows/{slug}/analytics          — Conversion analytics
```

## Example: SaddlePass

The SaddlePass onboarding demonstrates all features:
- 6 roles as card picker
- Horse Owner path: basic info → horse baseball cards (15 fields, repeatable) → listing prefs
- Barn Operator path: facility → disciplines checkboxes → amenities checkboxes → policies
- Rider/Trainer/etc: skip straight to completion
- Address autocomplete on facility step
- Phone formatting on phone fields
- Session resume via localStorage

View it: `iris onboard-flows view saddlepass-onboarding`
