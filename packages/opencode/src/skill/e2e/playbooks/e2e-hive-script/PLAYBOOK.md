---
name: e2e-hive-script
description: E2E test — hive-script execution via local daemon
version: 2
on-error: continue
timeout: 30
---

# E2E Hive Script Test

### step:ping Hive Ping

```yaml
mode: hive-script
```

```javascript
console.log(JSON.stringify({ ok: true, pid: process.pid }))
```

### step:verify Verify Hive Output

```yaml
mode: shell
depends: ping
```

```bash
echo "${{steps.ping.output}}" | grep -q '"ok"'
```
