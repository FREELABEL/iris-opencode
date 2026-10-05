---
name: e2e-hive
description: E2E test — hive task dispatch via local daemon (sandbox_execute)
version: 2
on-error: continue
timeout: 30
---

# E2E Hive Test

### step:ping Hive Sandbox Execute

```yaml
mode: hive
```

```bash
echo "hive-e2e-ok"
```

### step:verify Verify Hive Output

```yaml
mode: shell
depends: ping
```

```bash
echo "${{steps.ping.output}}" | grep -q "hive-e2e-ok"
```
