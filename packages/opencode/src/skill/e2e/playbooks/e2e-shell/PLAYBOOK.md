---
name: e2e-shell
description: E2E test — basic shell execution and step chaining
version: 2
on-error: continue
timeout: 30
---

# E2E Shell Test

### step:echo Echo Hello

```yaml
mode: shell
```

```bash
echo "hello-e2e"
```

### step:chain Verify Chain Output

```yaml
mode: shell
depends: echo
```

```bash
echo "${{steps.echo.output}}"
```

### step:env Environment Variable

```yaml
mode: shell
```

```bash
echo "$HOME"
```

### step:exit-zero Exit Code Zero

```yaml
mode: shell
```

```bash
true
```
