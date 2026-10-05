#!/usr/bin/env python3
"""
IRIS CLI — Device AFC bridge.
Outputs JSON to stdout for consumption by the TypeScript CLI.

Usage:
    python3 device-afc.py detect
    python3 device-afc.py storage
    python3 device-afc.py dcim
    python3 device-afc.py apps
    python3 device-afc.py offload <bundle-id>
    python3 device-afc.py icloud
"""

import sys
import json
import asyncio
import subprocess
import re
import plistlib
from pathlib import Path


def output(data):
    print(json.dumps(data))
    sys.exit(0)


def error(msg):
    print(json.dumps({"error": str(msg)}))
    sys.exit(1)


# ── detect ──────────────────────────────────────────────────

async def detect():
    """Detect connected iOS device and return basic info."""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        lockdown = await create_using_usbmux()
        name = await lockdown.get_value(key="DeviceName")
        output({
            "udid": lockdown.udid,
            "model": lockdown.product_type,
            "name": str(name) if name else lockdown.udid,
            "ios_version": lockdown.product_version,
        })
    except Exception as e:
        error(f"No device found: {e}")


# ── storage ─────────────────────────────────────────────────

async def storage():
    """Get REAL filesystem storage via AFC."""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await create_using_usbmux()
        async with AfcService(lockdown) as afc:
            info = await afc.get_device_info()
            total = int(info.get("FSTotalBytes", 0))
            free = int(info.get("FSFreeBytes", 0))
            output({
                "total_bytes": total,
                "free_bytes": free,
                "used_bytes": total - free,
                "model": info.get("Model", ""),
            })
    except Exception as e:
        error(f"Storage read failed: {e}")


# ── dcim ────────────────────────────────────────────────────

async def dcim():
    """Scan DCIM folders for photo/video file counts and size estimates."""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.afc import AfcService

        lockdown = await create_using_usbmux()
        async with AfcService(lockdown) as afc:
            dcim_dirs = await afc.listdir("/DCIM")
            folders = []
            total_files = 0
            sample_sizes = []

            for d in sorted(dcim_dirs):
                if d in (".", "..", ".MISC"):
                    continue
                try:
                    files = await afc.listdir(f"/DCIM/{d}")
                    real_files = [f for f in files if f not in (".", "..")]
                    count = len(real_files)
                    total_files += count
                    folders.append({"name": d, "count": count})

                    # Sample up to 5 files per folder for avg size
                    for fname in real_files[:5]:
                        try:
                            fi = await afc.stat(f"/DCIM/{d}/{fname}")
                            sample_sizes.append(int(fi.get("st_size", 0)))
                        except:
                            pass
                except:
                    pass

            avg_size = sum(sample_sizes) / len(sample_sizes) if sample_sizes else 0
            est_total = avg_size * total_files

            output({
                "total_files": total_files,
                "total_est_bytes": int(est_total),
                "avg_file_bytes": int(avg_size),
                "sample_count": len(sample_sizes),
                "folders": folders,
            })
    except Exception as e:
        error(f"DCIM scan failed: {e}")


# ── apps ────────────────────────────────────────────────────

async def apps():
    """Get per-app storage via pymobiledevice3 or ideviceinstaller fallback."""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.installation_proxy import InstallationProxyService

        lockdown = await create_using_usbmux()
        async with InstallationProxyService(lockdown) as inst:
            attrs = ["StaticDiskUsage", "DynamicDiskUsage", "CFBundleDisplayName", "CFBundleName"]
            app_list = await inst.get_apps("Any", attrs)
            sized = []
            for bid, info in app_list.items():
                name = (info.get("CFBundleDisplayName")
                        or info.get("CFBundleName")
                        or bid)
                static = info.get("StaticDiskUsage", 0)
                dynamic = info.get("DynamicDiskUsage", 0)
                sized.append({
                    "bundle_id": bid,
                    "name": name,
                    "static_size": static,
                    "dynamic_size": dynamic,
                    "total_size": static + dynamic,
                })

            sized.sort(key=lambda x: -x["total_size"])
            output({"apps": sized, "count": len(sized)})

    except Exception as e:
        # Fallback to ideviceinstaller
        try:
            result = subprocess.run(
                ["ideviceinstaller", "list", "--all",
                 "-a", "StaticDiskUsage", "-a", "DynamicDiskUsage",
                 "-a", "CFBundleDisplayName", "-a", "CFBundleName",
                 "-a", "CFBundleIdentifier", "--xml"],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                error(f"Device not found: {e}")

            app_list = plistlib.loads(result.stdout)
            sized = []
            for app in app_list:
                name = (app.get("CFBundleDisplayName")
                        or app.get("CFBundleName")
                        or app.get("CFBundleIdentifier", "?"))
                bid = app.get("CFBundleIdentifier", "")
                static = app.get("StaticDiskUsage", 0)
                dynamic = app.get("DynamicDiskUsage", 0)
                sized.append({
                    "bundle_id": bid,
                    "name": name,
                    "static_size": static,
                    "dynamic_size": dynamic,
                    "total_size": static + dynamic,
                })
            sized.sort(key=lambda x: -x["total_size"])
            output({"apps": sized, "count": len(sized)})
        except Exception as e2:
            error(f"App listing failed: {e2}")


# ── offload ─────────────────────────────────────────────────

async def offload(bundle_id):
    """Offload an app (remove binary, keep data)."""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.services.installation_proxy import InstallationProxyService

        lockdown = await create_using_usbmux()
        async with InstallationProxyService(lockdown) as inst:
            await inst.uninstall(bundle_id)
            output({"success": True, "bundle_id": bundle_id})
    except Exception as e:
        error(f"Offload failed for {bundle_id}: {e}")


# ── icloud ──────────────────────────────────────────────────

def icloud():
    """Parse brctl dump for iCloud sync status."""
    try:
        result = subprocess.run(
            ["brctl", "dump"],
            capture_output=True, timeout=60, text=True
        )
        raw = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout)  # strip ANSI

        # Available quota
        quota_match = re.search(r'availableQuota\s*=\s*(\d+)', raw)
        available_quota = int(quota_match.group(1)) if quota_match else -1

        # Stuck sync items
        sync_up_count = raw.count("needs-sync-up")

        # Last sync
        last_sync_match = re.search(r'last-sync:(\d{4}-\d{2}-\d{2}\s[\d:.]+)', raw)
        last_sync = last_sync_match.group(1) if last_sync_match else "unknown"

        # Sync budget
        budget_match = re.search(r'syncUpBudget\s*=\s*(\d+)', raw)
        sync_budget = int(budget_match.group(1)) if budget_match else -1

        # Last quota fetch
        fetch_match = re.search(r'lastQuotaFetchDate\s*=\s*"([^"]+)"', raw)
        last_quota_fetch = fetch_match.group(1) if fetch_match else "unknown"

        is_deadlocked = available_quota == 0 and sync_up_count > 0

        output({
            "available_quota": available_quota,
            "sync_up_stuck": sync_up_count,
            "last_sync": last_sync,
            "sync_budget": sync_budget,
            "last_quota_fetch": last_quota_fetch,
            "is_deadlocked": is_deadlocked,
        })
    except subprocess.TimeoutExpired:
        error("brctl dump timed out")
    except Exception as e:
        error(f"iCloud check failed: {e}")


# ── main ────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        error("Usage: device-afc.py <action> [args]")

    action = sys.argv[1]

    if action == "detect":
        asyncio.run(detect())
    elif action == "storage":
        asyncio.run(storage())
    elif action == "dcim":
        asyncio.run(dcim())
    elif action == "apps":
        asyncio.run(apps())
    elif action == "offload":
        if len(sys.argv) < 3:
            error("Usage: device-afc.py offload <bundle-id>")
        asyncio.run(offload(sys.argv[2]))
    elif action == "icloud":
        icloud()
    else:
        error(f"Unknown action: {action}")


if __name__ == "__main__":
    main()
