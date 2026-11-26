#!/usr/bin/env python3
"""
Build the bundled model-details snapshot the Desktop model picker falls back to (#194383).

The live copy is served by fl-iris-api (GET /api/v6/openai/models/details) from the public
`model-cards` dataset plus usage measured from the proxy log. This snapshot is what the picker
shows offline, or before that endpoint exists. Nothing in it is invented:

  - `good_for` / `about` are written by hand below, from IRIS's own catalogue notes
    (GET https://heyiris.io/api/v1/public/models) and our measured runs.
  - `public` scores are copied from the Artificial Analysis leaderboard page, fetched at build
    time, with the date. A model with no published score gets none — the picker says so.
  - `iris` results are IRIS's own grounding test, Round 06 (2026-11-13, ticket #194083),
    published at https://heyiris.io/p/agent-model-benchmark.

Usage:  python3 -I build.py <artificialanalysis leaderboard .html> src/components/model-details/snapshot.ts [--rows rows.json]
Fetch:  curl -s -A "Mozilla/5.0" https://artificialanalysis.ai/leaderboards/models -o aa.html
"""
import datetime
import json
import re
import sys

AA_URL = "https://artificialanalysis.ai/leaderboards/models"
BENCH_URL = "https://heyiris.io/p/agent-model-benchmark"
BENCH_DATE = "2026-11-13"

# Hand-written, plain words. Keyed by the IRIS model id (no "iris/" prefix). `runs_on` is the
# model a tier routed to on the snapshot date; the live endpoint replaces it with today's.
CURATED = {
    "iris-ai": {
        "good_for": ["Everyday questions", "Writing and editing", "Working with your apps"],
        "about": "The model you get without choosing. IRIS moves it to whichever model is answering best right now.",
        "runs_on": "deepseek-v4.1-flash",
    },
    "iris-ai-reasoning": {
        "good_for": ["Questions with a right answer", "Checking facts", "Quick thinking"],
        "about": "Thinks before it answers and is the fastest we have measured that won't make up a number.",
        "runs_on": "glm-5.3-flash",
    },
    "iris-pro": {
        "good_for": ["Answers that must be right", "Hard problems", "Careful research"],
        "about": "The most careful model we offer. Best of ten on our fact test, but it can take a minute or two, so pick it on purpose.",
        "runs_on": "qwen3.7-plus",
    },
    "genesis-designer": {
        "good_for": ["Web pages", "Designs and graphics", "Genesis pages"],
        "about": "Built for pages and visuals. It follows the IRIS design standard on every request.",
        "runs_on": "gpt-6-luna",
    },
    "gpt-6-luna": {
        "good_for": ["Fast everyday work", "Writing", "Designs and pages"],
        "about": "The small model of OpenAI's GPT-6 line. Quick and steady, even when lots of people are using it.",
    },
    "gpt-5.6-luna": {
        "good_for": ["Fast everyday work", "Writing", "Short tasks"],
        "about": "OpenAI's earlier small model. Passed every test in our core suite with clean answers.",
    },
    "glm-5.3-flash": {
        "good_for": ["Quick answers", "Lots of small tasks", "Saving money"],
        "about": "The cheapest per answer of anything we run, and careful about not inventing facts.",
    },
    "deepseek-v4.1-flash": {
        "good_for": ["Everyday questions", "Writing", "Long documents"],
        "about": "A low-cost all-rounder. It thinks at length, so some answers take a while.",
    },
    "deepseek-v4-pro": {
        "good_for": ["Harder reasoning", "Coding", "Longer answers"],
        "about": "The larger, paid DeepSeek model, for work that needs more than the Flash version.",
    },
    "minimax-m3": {
        "good_for": ["Long prompts", "Everyday work", "A reliable backup"],
        "about": "Answers long requests directly instead of thinking itself into an empty reply.",
    },
    "mimo-v2.6-flash": {
        "good_for": ["Quick answers", "Saving money"],
        "about": "One of the cheapest paid models we serve.",
    },
    "hy3": {
        "good_for": ["Thinking problems through", "Low cost per word"],
        "about": "Cheap per word, but it reasons at length before answering, so replies can be slow.",
    },
    "qwen3.7-plus": {
        "good_for": ["Careful answers", "Research", "Hard problems"],
        "about": "The model behind IRIS Pro. Very careful, but slow to answer.",
    },
    "qwen3.8-flash": {
        "good_for": ["Quick answers", "Saving money"],
        "about": "The fast, low-cost Qwen model.",
    },
    "qwen3.8-max": {
        "good_for": ["Hard problems", "Reasoning"],
        "about": "The largest Qwen model we serve.",
    },
    "kimi-k2.7-code": {
        "good_for": ["Coding", "Fixing bugs", "Working in a project"],
        "about": "Moonshot's model made for writing and fixing code.",
    },
    "gemini-4-argon": {
        "good_for": ["Hard problems", "Images and documents", "Long documents"],
        "about": "One of Google's most capable models, and among the highest scoring we serve.",
    },
    "gemini-4-hydrogen": {
        "good_for": ["Hard problems", "Fast answers", "Images and documents"],
        "about": "A top-scoring Google model that is also fast.",
    },
    "gemini-3.1-pro": {
        "good_for": ["Hard problems", "Images and documents"],
        "about": "Google's earlier Pro model.",
    },
    "gemini-3-flash": {"good_for": ["Quick answers", "Images and documents"], "about": "A fast Google model."},
    "gemini-3.5-flash": {"good_for": ["Everyday work", "Images and documents"], "about": "A fast, capable Google model."},
    "gemini-3.5-flash-lite": {
        "good_for": ["Very fast answers", "Saving money"],
        "about": "Google's lightest model. Very fast and low cost.",
    },
    "gemini-3.6-flash": {"good_for": ["Everyday work", "Images and documents"], "about": "A fast, capable Google model."},
    "gemini-3.7-flash": {"good_for": ["Everyday work", "Images and documents"], "about": "A fast, capable Google model."},
    "gemini-3.8-flash": {"good_for": ["Everyday work", "Images and documents"], "about": "A fast, capable Google model."},
}

# IRIS grounding test, Round 06 (#194083 §2). Keyed by the model that ran. `accuracy` is the
# mean answer score out of 100, `worst` the lowest run, `honest` how many of the trap questions
# it refused to invent an answer for, `finished` how many runs returned an answer at all.
IRIS_BENCH = {
    "gpt-6-luna": {"accuracy": 100, "worst": 100, "honest": [1, 5], "finished": [5, 5], "seconds": 8.4},
    "glm-5.3-flash": {"accuracy": 95, "worst": 82, "honest": [4, 5], "finished": [5, 5], "seconds": 10.6},
    "gpt-5.6-luna": {"accuracy": 95, "worst": 77, "honest": [2, 5], "finished": [5, 5], "seconds": 7.5},
    "qwen3.8-flash": {"accuracy": 93, "worst": 77, "honest": [3, 5], "finished": [5, 5], "seconds": 28.4},
    "qwen3.7-plus": {"accuracy": 88, "worst": 64, "honest": [5, 5], "finished": [5, 5], "seconds": 110.5},
    "deepseek-v4.1-flash": {"accuracy": 70, "worst": 40, "honest": [1, 2], "finished": [2, 5], "seconds": 42.6},
}

# Our id -> the leaderboard's slug, where normalising the name is not enough.
AA_ALIASES = {
    "deepseek-v4.1-flash": "deepseek-v4-1-flash-1017",
    "gemini-3.1-pro": "gemini-3-1-pro-preview",
}


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def leaderboard(path: str) -> list[dict]:
    text = open(path, encoding="utf-8").read().replace('\\"', '"').replace("\\\\", "\\")
    decoder = json.JSONDecoder()
    best: dict[str, dict] = {}
    for match in re.finditer(r'\{"id":"[0-9a-f-]{36}","release":\{', text):
        try:
            obj, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if "intelligenceIndex" not in obj or obj.get("deprecated"):
            continue
        slug = obj["release"]["slug"]
        # One row per model: its best setting (a model is listed once per reasoning level).
        if slug not in best or (obj.get("intelligenceIndex") or 0) > (best[slug].get("intelligenceIndex") or 0):
            best[slug] = obj
    rows = [
        {
            "slug": slug,
            "name": o["release"]["name"],
            "maker": o.get("modelCreatorName"),
            "smarts": round(o["intelligenceIndex"], 1) if o.get("intelligenceIndex") is not None else None,
            "speed": round(o["outputSpeed"]) if o.get("outputSpeed") else None,
            "first_token": round(o["timeToFirstToken"], 1) if o.get("timeToFirstToken") else None,
        }
        for slug, o in best.items()
    ]
    scored = sorted((r for r in rows if r["smarts"] is not None), key=lambda r: -r["smarts"])
    for index, row in enumerate(scored):
        row["rank"] = index + 1
    return rows, len(scored)


def main() -> None:
    if len(sys.argv) not in (3, 5):
        sys.exit(__doc__)
    rows, scored = leaderboard(sys.argv[1])
    if scored < 50:
        sys.exit(f"only {scored} scored models parsed — the page layout changed; refusing to write a thin snapshot")
    today = datetime.date.today().isoformat()
    public = {}
    for row in rows:
        entry = {k: row[k] for k in ("name", "maker", "smarts", "rank", "speed", "first_token") if row.get(k) is not None}
        public[row["slug"]] = entry
    out = {
        "version": 1,
        "as_of": today,
        "sources": {
            "public": {"name": "Artificial Analysis", "url": AA_URL, "as_of": today, "ranked": scored},
            "iris": {"name": "IRIS fact test", "url": BENCH_URL, "as_of": BENCH_DATE},
        },
        "aliases": AA_ALIASES,
        "models": CURATED,
        "iris_bench": IRIS_BENCH,
        "public": public,
    }
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        fh.write("// Generated by packages/app/script/model-details/build.py (#194383). Do not edit by hand:\n")
        fh.write("// change CURATED there, or the live `model-cards` dataset, and re-run it.\n")
        fh.write("export default ")
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"wrote {sys.argv[2]}: {len(CURATED)} described, {scored} ranked publicly, {len(IRIS_BENCH)} measured by IRIS")
    if len(sys.argv) == 5 and sys.argv[3] == "--rows":
        # The same document as rows for the live `model-cards` dataset fl-iris-api serves
        # (GET /api/v6/openai/models/details): {kind, key, payload}. Import with
        #   iris datasets import model-cards <file> (upsert on kind+key)
        rows = [{"kind": "source", "key": k, "payload": json.dumps(v)} for k, v in out["sources"].items()]
        rows += [{"kind": "alias", "key": k, "payload": v} for k, v in out["aliases"].items()]
        rows += [{"kind": "card", "key": k, "payload": json.dumps(v, ensure_ascii=False)} for k, v in out["models"].items()]
        rows += [{"kind": "iris", "key": k, "payload": json.dumps(v)} for k, v in out["iris_bench"].items()]
        rows += [{"kind": "public", "key": k, "payload": json.dumps(v, ensure_ascii=False)} for k, v in out["public"].items()]
        for row in rows:
            row["external_id"] = f"{row['kind']}:{row['key']}"
        with open(sys.argv[4], "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=1, ensure_ascii=False)
        print(f"wrote {sys.argv[4]}: {len(rows)} dataset rows")


if __name__ == "__main__":
    main()
