---
name: e2e-interpolation
description: E2E test — argument, env, and step-ref interpolation
version: 2
args:
  name:
    type: string
    required: false
    default: "alice"
  count:
    type: number
    required: false
    default: 7
on-error: continue
timeout: 30
---

# E2E Interpolation Test

### step:args Argument Interpolation

```yaml
mode: shell
```

```bash
echo "${{args.name}}-${{args.count}}"
```

### step:env-var Environment Interpolation

```yaml
mode: shell
```

```bash
echo "${{env.HOME}}"
```

### step:multi Multi-Reference Interpolation

```yaml
mode: shell
depends: args
```

```bash
echo "${{steps.args.output}} ${{steps.args.exit_code}}"
```
