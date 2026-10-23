---
category: Getting Started
level: beginner
tags: [onboarding, next, getting-started, first-steps, brand, website, site]
duration_min: 2
---
# How to: Find your next step

## What this does

`iris next` looks at your account — workspace, brand, connected tools, pages — and prints **one**
thing to do next, with the command to run.

```bash
iris next
iris next --json      # always exactly one item: { id, title, command, who, minutes, why }
```

## Already have a website?

```bash
iris next --site https://yourcompany.com
```

IRIS reads the site for your brand and context, creates a workspace if you have none, and saves
what it found.
