---
name: e2e-cloud-smoke
description: E2E test — cloud API reachability (read-only health check)
version: 2
on-error: continue
timeout: 30
---

# E2E Cloud Smoke Test

### step:health API Health Check

```yaml
mode: shell
```

```bash
curl -sf https://freelabel.net/api/health || echo "UNREACHABLE"
```
