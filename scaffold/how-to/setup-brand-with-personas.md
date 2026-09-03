---
category: Content & Media
level: intermediate
tags: [brands, personas, content]
duration_min: 10
---
# How to: Set up a brand with personas for multi-voice content

## What this does
Creates a brand entity with one or more personas (voice/tone profiles). Each persona can have its own system prompt, hashtags, style guidelines, and AI settings. Used for the multi-persona content engine (e.g., 6 IG accounts, each a different finance archetype).

## Prerequisites
- IRIS CLI authenticated
- Know which bloq to attach the brand to (or use `--bloq=null` for agency-level)

## Steps

### 1. Create the brand
```bash
iris brands create \
  --name="Good Deals" \
  --slug=good-deals \
  --entity-type=business \
  --description="Financial advisory for creators"
```

### 2. Add personas
```bash
# The warm advisor (default voice)
iris brands personas add <brand_id> \
  --name="Trusted Planner" \
  --archetype=trusted_planner \
  --tone="warm, knowledgeable financial advisor who speaks plainly" \
  --system-prompt="You are a certified financial planner helping creative professionals..." \
  --target-demographic="single professionals 25-35" \
  --default

# The hype curator (secondary voice)
iris brands personas add <brand_id> \
  --name="Hype Curator" \
  --archetype=hype_curator \
  --tone="energetic, Gen-Z, meme-aware" \
  --target-demographic="young creators 18-24"

# The newsreader (authority voice)
iris brands personas add <brand_id> \
  --name="Market Reporter" \
  --archetype=newscaster \
  --tone="professional, data-driven, CNBC style" \
  --target-demographic="married couples 30-50"
```

### 3. Attach social accounts
```bash
# Link an existing Instagram integration to this brand
iris brands integrations attach <brand_id> <integration_id>

# List what's connected
iris brands show <brand_id>
```

### 4. Set the default persona
```bash
iris brands personas default <brand_id> <persona_id>
```

### 5. Use with Copycat content pipeline
```bash
# Clip a video using the brand's default persona voice/style
iris copycat clip "https://youtube.com/watch?v=abc" --brand=good-deals

# Publish to the brand's connected social accounts
iris copycat publish <content_id> --brands=good-deals
```

## How it works
- `BrandCaptionService` does DB-first lookup: finds the brand by slug, loads its default persona, uses persona's `system_prompt` and `style_guidelines` for AI caption generation
- `UploadPostService` does DB-first social routing: brand slug -> integrations where brand_id + category=social + type=social-{platform} -> posts to that account
- iris-api caches fl-api brand data for 5 minutes (auto-merge on cold start)
- Falls through to legacy config/brandcaptions.php if no DB match — safe for migration

## Tips
- Agency-level brands (no bloq_id) are reusable across all bloqs
- `metadata` field on brands is free-form JSON — store colors, fonts, logos there
- Brand assets (logos, intros, audio drops) go in cloud files: `iris cloud:upload ./logo.png --brand=<brand_id>`
