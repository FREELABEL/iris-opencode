---
name: e2e-error-handling
description: E2E test — multi-step error handling and on-error continue
version: 2
on-error: continue
timeout: 30
---

# E2E Error Handling Test

### step:pass Passing Step

```yaml
mode: shell
```

```bash
echo "step-pass-ok"
```

### step:fail Intentional Failure

```yaml
mode: shell
```

```bash
exit 1
```

### step:after-fail After Failure

```yaml
mode: shell
```

```bash
echo "continued-after-failure"
```

### step:verify Verify Continuation

```yaml
mode: shell
depends: after-fail
```

```bash
test "${{steps.after-fail.output}}" = "continued-after-failure"
```
