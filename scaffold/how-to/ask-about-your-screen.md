---
category: Getting Started
level: beginner
tags: [look, screen, screenshot, vision, ask, ocr]
duration_min: 3
---
# How to: Ask about anything on your screen

## What this does

Drag over any part of your screen — an error, a chart, a message — and get an answer about it in
a few sentences. Nothing to install on a Mac; on Linux it uses the screenshot tool you already have.

![Run iris look with a question. Drag a box over the part of the screen you mean, such as a failing test. IRIS reads that region and prints a short answer in your terminal. The screenshot is deleted after the answer unless you add --keep.](https://cdn.heyiris.io/cloud-files/1792224641_ask-about-your-screen-how.png)

## Before you start

- IRIS installed and signed in: `iris auth login`
- A machine with a screen: a Mac, or Linux with a desktop. On a server, use `--image` instead.

## Step 1: Ask

```bash
iris look "why is this test failing?"
```

Drag over what you want to ask about. **Esc** cancels. The answer prints right there:

```
The test expects 81 but the code produces 90 — a 10% discount on 100 is 90, so either the
test's expectation or the discount rule is wrong.
```

The screenshot is deleted after the answer, unless you add `--keep`.

## Step 2: Ask about an image you already have

```bash
iris look --image chart.png "what does this chart say?"
```

## Step 3: Put it on a key

- **macOS**: Shortcuts app → new shortcut → *Run Shell Script* → `iris look`, then assign a
  keyboard shortcut.
- **Linux**: your desktop's custom shortcuts (GNOME, KDE, Hyprland/Omarchy binds) → `iris look`.

## Common problems

**"No region picker found"** (Linux) — install one: `sudo apt install maim` (X11) or `slurp` +
`grim` (Wayland).

**"No screen here"** — you ran it on a server with no display. Run it on the machine you are
looking at, or use `--image`.

To pull just the text out of an image instead, use `iris ocr <image>`.

## Related

- `run-code-in-a-sandbox.md`: run the fix it suggests in a throwaway box
