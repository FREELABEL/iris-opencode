# Spec: `iris leads link` — Lead-to-Lead Relationship Management

## Problem

Real business relationships are networked, not flat:
- Drew Gibbs is a contact AT Slingshot Law (lead #9757)
- Lisa Martinez has a duplicate record (#67 and #20119)
- Andrew Esher is both a client AND a referral partner
- An investor sends $2,500 via Apple Pay — they're connected to multiple deals

The CLI has no way to express "this lead is connected to that lead" or "this person works at this company." You have to manually add notes, which are unstructured and unsearchable.

## What exists today

- `iris leads merge` — combines duplicates (destructive — deletes one)
- `iris leads note` — free text, no structure
- `bloq_relations` table — typed edges between bloqs (built today, #57794)
- `som_leads` has no relationship/link columns

## What to build

### `iris leads link <lead-id> <target-lead-id> --type <relationship>`

```bash
# Drew works at Slingshot Law
iris leads link 99999 9757 --type works_at

# Andrew is a referral partner
iris leads link 16387 193 --type partner

# Investor is connected to the event deal
iris leads link 99998 1350 --type investor --entity event

# Lisa's two records are the same person
iris leads link 67 20119 --type duplicate
```

### Relationship types

```
works_at       — person → company (employee/contractor)
manages        — person → person (manager relationship)
partner        — bidirectional business partnership
referral       — person A referred person B
investor       — person invested in entity/deal
vendor         — company provides services to another
duplicate      — same person, suggests merge
family         — personal connection
custom         — free-form with --label
```

### Data model

New table: `lead_relations`

```sql
CREATE TABLE lead_relations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_lead_id BIGINT UNSIGNED NOT NULL,
  to_lead_id BIGINT UNSIGNED NULL,          -- nullable if linking to non-lead entity
  to_entity_type VARCHAR(50) NULL,           -- 'event', 'bloq', 'profile', etc.
  to_entity_id BIGINT UNSIGNED NULL,
  relation_type VARCHAR(30) NOT NULL,
  label VARCHAR(100) NULL,                   -- custom label for 'custom' type
  metadata JSON NULL,                        -- role, title, deal amount, etc.
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NULL,
  updated_at TIMESTAMP NULL,

  UNIQUE KEY lead_rel_unique (from_lead_id, to_lead_id, relation_type),
  INDEX idx_to (to_lead_id),
  INDEX idx_type (relation_type),
  FOREIGN KEY (from_lead_id) REFERENCES som_leads(id) ON DELETE CASCADE
);
```

### CLI commands

```bash
# Link two leads
iris leads link <from-id> <to-id> --type works_at
iris leads link <from-id> <to-id> --type partner --label "Revenue share deal"

# Link lead to non-lead entity
iris leads link <lead-id> <event-id> --type vendor --entity event

# View a lead's connections
iris leads connections <lead-id>
# Output:
#   Drew Gibbs (#99999)
#   ├── works_at → Slingshot Law (#9757)
#   ├── investor → Song Wars Ep.1 (event #1350)
#   └── referral ← Andrew Esher (#16387)

# Unlink
iris leads unlink <from-id> <to-id> --type works_at

# Show in pulse
# Pulse should display a "Connections" section showing related leads
```

### Smart create with auto-link

```bash
# When --company matches an existing lead, auto-link
iris leads create --name "Drew Gibbs" --phone "+15551234567" --company "Slingshot Law"
# → Creates Drew as lead #99999
# → Finds "Slingshot Law" lead #9757
# → Auto-creates: link 99999 → 9757 --type works_at
# → Output: "Created #99999. Auto-linked to Slingshot Law (#9757)"
```

### Pulse integration

Add a "Connections" section to pulse output:

```
  Connections  (3)
    works_at → Slingshot Law (#9757)  Active
    referral ← Andrew Esher (#16387)  Won
    investor → Song Wars Ep.1 (event #1350)
```

### Files to create/modify

| File | Action |
|------|--------|
| `fl-api/database/migrations/..._create_lead_relations_table.php` | Create |
| `fl-api/app/Models/LeadRelation.php` | Create |
| `fl-api/app/Http/Controllers/Bloq/LeadController.php` | Add link/unlink/connections endpoints |
| `fl-api/routes/api/lead-management-routes.php` | Add routes |
| `iris-code/src/cli/cmd/platform-leads.ts` | Add link/unlink/connections commands |
| `iris-code/src/cli/cmd/platform-leads.ts` | Update create to auto-link on company match |
| `iris-code/src/cli/cmd/platform-leads.ts` | Update pulse to show connections |
| `iris-code/test/cli/lead-linking.test.ts` | Tests |

### Implementation order

1. Migration + model
2. API endpoints (link, unlink, connections)
3. CLI commands (link, unlink, connections)
4. Smart create auto-link
5. Pulse connections section
6. Tests
