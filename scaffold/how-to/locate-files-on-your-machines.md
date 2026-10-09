---
category: Hive
level: beginner
tags: [hive, files, search, locate, fsearch, spotlight, plocate, windows-search]
duration_min: 5
---
# Find a file on any machine you own

One command searches every machine in your Hive. Each machine answers with the best search engine
it has for its platform, and the results say which engine answered and what it covers.

```bash
iris locate "invoice march"
```

```
  6 file(s) matching "invoice march" on 2 machine(s)  ·  1840 ms

  Alexs-MacBook-Pro   3 found · fsearch · 1120 ms
    ~/Documents/Finance/Invoice March 2026.pdf
    …
  iris-hive-001       3 found · plocate · 640 ms
    ~/exports/invoice-march.csv
    …
```

## Which engine each machine uses

| Platform | Best | Then | Fallback |
|---|---|---|---|
| macOS | **fsearch** — ~7 ms, forgives typos, finds hidden folders, searches inside files | Spotlight — on every Mac | home-folder scan |
| Linux | **plocate** — ~20 ms, whole disk | locate | home-folder scan |
| Windows | **Windows Search** — built in, your indexed folders | — | home-folder scan |

```bash
iris locate providers             # what each machine uses, and what it is missing
iris locate setup --node macbook  # build fsearch on a Mac (needs ~1 GB free while it builds)
iris locate setup --node my-linux # install plocate on a Linux machine (needs admin)
```

A home-folder scan is labelled as one, so "nothing found" from a scan is never mistaken for "not
on this machine". `setup` turns the scan into a whole-disk index.

## More ways to ask

```bash
iris locate brand-contract --node macbook          # one machine
iris locate "grep:applyDiscount ext:ts" --node mac # inside files (fsearch)
iris locate invoice --provider spotlight           # force one engine
iris locate invoice --json                         # for scripts
```

## What leaves the machine

The search engines run on the machine itself. fsearch is MIT-licensed and has no network code;
plocate, Spotlight and Windows Search are part of the operating system. The **file names** that
match go back to your IRIS account as the search result — file contents never do.
