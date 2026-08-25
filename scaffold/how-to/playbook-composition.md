---
category: Playbooks & Automation
level: intermediate
tags: [playbooks, composition, chaining, automation]
duration_min: 8
prerequisites: [playbook-sops-and-skills]
---
# How to: Chain playbooks together

## What this does

A playbook step can run **another playbook**. The child executes inline, its steps appear nested in the run output, and its combined output becomes the parent step's result.

This has worked since the executor shipped. At the time of writing **no playbook in the registry used it**, because nothing in the help text, the docs, or any existing playbook said it was possible — so people wrote "now go and run X" as an instruction a human has to notice and follow, which is a chain edge that only exists in prose.

## The syntax

```markdown
### step:s2 Capture the process as an SOP

```yaml
mode: playbook
playbook: capture-sops-and-process-maps
args: intake-approval
```

```text
Runs the SOP-capture playbook against the intake process.
```
```

- `mode: playbook` — `mode: skill` is an accepted alias.
- `playbook:` — the child's name, as it appears in `iris playbook list`.
- `args:` — optional. **Positional**: they map onto the child's declared args in declaration order.

## Steps

### 1. Confirm the child exists and takes what you think

```bash
iris playbook list
iris playbook show <child-name>
```

Argument mapping is positional, so the child's declaration *order* determines meaning. Read it before you pass anything.

### 2. Add the delegating step to the parent

Author it as above. The body fence still matters — write what the step is for, since that is what a person reads on the page.

### 3. Validate, then run

```bash
iris playbook test <parent-name>
iris playbook run <parent-name>
```

A successful chain renders the child nested inside the parent step:

```
p1: Before
✓ p1: Before (0.0s)
p2: Delegate to the child playbook
  c1: Say who I am
  ✓ c1: Say who I am (0.0s)
✓ p2: Delegate to the child playbook (0.0s)
```

## When to chain, and when not to

**Chain** when the child is a genuine standalone procedure someone would also run on its own — capturing an SOP, deploying, running a review. One procedure per playbook, composed.

**Do not chain** to avoid writing three steps. A playbook that exists only to be called once, by one parent, is a section of the parent wearing a costume — and it costs a reader a page navigation to find out what it does.

## Limits, all real

- **Nesting is capped at 3.** Exceeding it throws `Maximum skill nesting depth (3) exceeded`.
- **A playbook cannot call itself.** Direct self-reference is refused at validation.
- **Indirect cycles are NOT detected.** `A → B → A` is caught only by the depth cap, so it surfaces as a confusing depth error rather than "you have a cycle."
- **A failing child fails the parent step.** The parent step's exit code is non-zero unless the child completes.
- **Args are positional only.** There is no `args: key=value` form yet, so reordering a child's declared args silently changes what every caller passes.
- **A missing child is a step failure, not a validation failure** — `iris playbook test` will not catch a typo'd child name; the run will.

## Gotchas

- The child's output that reaches the parent is the concatenation of its **successful** steps only.
- A v1 (unstructured) child is not executed — its file content is loaded as the step's output instead. That is deliberate, but it means chaining to a v1 playbook reads as "it worked" while running nothing.
- Chaining does not sync: the child must exist wherever the parent runs. Publish both.

## Related

- `iris playbook --help` — the composition summary lives in its epilogue
- `playbook-sops-and-skills` — how a playbook holds human SOPs alongside agent skills
- Epic #182309 — branching (`if X run A else B`), fan-out over a list, named args, and a visible dependency graph are tracked there
