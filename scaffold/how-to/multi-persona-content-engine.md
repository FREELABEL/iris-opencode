# How to: Run the multi-persona content engine (6-IG-account model)

## What this does
Create multiple brand personas, each with their own voice/tone/demographic, and route content through the Copycat pipeline to different social accounts. This is the "$1.8B one-man business" model — one person, multiple AI-driven accounts targeting different audiences.

## The concept
The model here: 6 Instagram accounts, each a different finance archetype:
1. Single young women
2. Single young men
3. Married couples
4. People going through divorce
5. People retiring
6. General lifestyle/positivity

Each account gets persona-specific content generated from the same source material.

## Steps

### 1. Create the parent brand
```bash
iris brands create --name="Good Deals Finance" --slug=good-deals-finance --entity-type=business
# Note the brand_id returned (e.g., 7)
```

### 2. Create one persona per archetype
```bash
iris brands personas add 7 --name="Career Queen" \
  --archetype=single_women_25_35 \
  --tone="empowering, practical, girlfriend-advice style" \
  --system-prompt="You're a financial advisor who speaks to ambitious single women. Focus on investing, salary negotiation, and building wealth independently." \
  --target-demographic="single women 25-35"

iris brands personas add 7 --name="Money Moves" \
  --archetype=single_men_25_35 \
  --tone="direct, ambitious, no-BS finance bro without the cringe" \
  --system-prompt="You're a financial coach for young men building their first real wealth. Cover crypto basics, real estate, and career income growth." \
  --target-demographic="single men 25-35"

iris brands personas add 7 --name="Together Wealth" \
  --archetype=married_couples \
  --tone="warm, partnership-focused, practical" \
  --system-prompt="You're a couples financial planner. Focus on joint accounts, mortgage planning, college savings, and balancing two incomes." \
  --target-demographic="married couples 30-50"

# ... repeat for divorce, retirement, lifestyle
```

### 3. Connect social accounts to personas
```bash
# Each persona should have its own IG integration
# First, connect the IG accounts via OAuth (one per persona):
iris run --connect instagram   # Follow OAuth flow for account 1
iris run --connect instagram   # Repeat for account 2, etc.

# Then attach each integration to the brand
iris brands integrations attach 7 <integration_id_1>
iris brands integrations attach 7 <integration_id_2>
```

### 4. Generate persona-specific content from a single source
```bash
# Transcribe one video (the raw material)
iris copycat transcribe "https://youtube.com/watch?v=SOURCE_VIDEO"

# Generate articles/clips with different persona voices
iris copycat clip "https://youtube.com/watch?v=SOURCE_VIDEO" --brand=good-deals-finance
# The brand's default persona determines the voice/style

# To use a specific persona, switch the default first:
iris brands personas default 7 <career_queen_persona_id>
iris copycat clip "https://youtube.com/watch?v=SOURCE_VIDEO" --brand=good-deals-finance

iris brands personas default 7 <money_moves_persona_id>
iris copycat clip "https://youtube.com/watch?v=SOURCE_VIDEO" --brand=good-deals-finance
```

### 5. Publish to each persona's account
```bash
iris copycat publish <content_id> --brands=good-deals-finance
```

## Current limitations (honest)
- **Voice clone not wired yet** — personas have `voice_sample_id` field but no audio generation provider (ElevenLabs/Cartesia) integrated. Coming in Track 4 Phase 2.
- **No auto-schedule** — you manually switch default persona and generate per account. Automation via Hive scheduled tasks is the next step.
- **No auto-persona-routing** — the system doesn't yet auto-split one video into 6 persona variants in one command. That's the "campaign" feature in the gap plan.
- **IG multi-account OAuth** — you need to go through OAuth separately for each IG account.

## What DOES work today
- Create brands + personas with full AI config (system_prompt, tone, style_guidelines, hashtags)
- BrandCaptionService uses the default persona's system_prompt when generating captions
- UploadPostService routes to the brand's connected social accounts
- iris-api auto-merges brand data from fl-api (5-min cache)
- All 20 Copycat actions available via `iris copycat <action>`

## Future vision
```bash
# ONE command, 6 persona-specific clips, auto-scheduled across 6 accounts
iris copycat campaign create \
  --brand=good-deals-finance \
  --source="https://youtube.com/watch?v=SOURCE" \
  --personas=all \
  --schedule=daily
```
