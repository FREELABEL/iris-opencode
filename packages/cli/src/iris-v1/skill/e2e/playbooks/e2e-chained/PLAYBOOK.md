---
name: e2e-chained
description: E2E test — step chaining, transforms, and conditional logic
version: 2
args:
  run_conditional:
    type: string
    required: false
    default: "no"
on-error: continue
timeout: 30
---

# E2E Chained Steps Test

### step:generate Generate Payload

```yaml
mode: shell
```

```bash
echo "PAYLOAD_42"
```

### step:transform Transform to Lowercase

```yaml
mode: shell
depends: generate
```

```bash
echo "${{steps.generate.output}}" | tr '[:upper:]' '[:lower:]'
```

### step:validate Validate Transform

```yaml
mode: shell
depends: transform
```

```bash
test "${{steps.transform.output}}" = "payload_42"
```

### step:conditional Conditional Step

```yaml
mode: shell
if: ${{args.run_conditional}} == yes
```

```bash
echo "ran"
```
