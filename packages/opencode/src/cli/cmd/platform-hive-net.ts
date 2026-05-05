import { cmd } from "./cmd"
import { dim, bold, success } from "./iris-api"
import { execSync, spawnSync, spawn } from "child_process"
import { networkInterfaces } from "os"

// ============================================================================
// iris hive scan / probe / ssh
//
// Local LAN discovery utility — finds candidate machines for Hive enrollment.
// Pure local, no API calls. Works on macOS + Linux (uses arp, ping, nc, dig).
// ============================================================================

const OUI_VENDORS: Record<string, string> = {
  // Dell
  "b8:ca:3a": "Dell", "d4:81:d7": "Dell", "f8:b1:56": "Dell", "f8:bc:12": "Dell",
  "f4:8e:38": "Dell", "f0:1f:af": "Dell", "e4:f0:04": "Dell", "e0:db:55": "Dell",
  "d0:67:e5": "Dell", "c8:1f:66": "Dell", "b0:83:fe": "Dell", "a4:1f:72": "Dell",
  "a0:36:bc": "Dell", "98:90:96": "Dell", "90:b1:1c": "Dell", "84:8f:69": "Dell",
  "78:2b:cb": "Dell", "74:e6:e2": "Dell", "74:86:7a": "Dell", "70:b5:e8": "Dell",
  "6c:2b:59": "Dell", "64:00:6a": "Dell", "54:9f:35": "Dell", "50:9a:4c": "Dell",
  "50:65:f3": "Dell", "4c:76:25": "Dell", "44:a8:42": "Dell", "34:17:eb": "Dell",
  "24:6e:96": "Dell", "18:fb:7b": "Dell", "14:fe:b5": "Dell", "10:7d:1a": "Dell",
  "00:14:22": "Dell", "00:18:8b": "Dell", "00:1d:09": "Dell", "00:24:e8": "Dell",
  "00:26:b9": "Dell", "00:21:9b": "Dell", "00:22:19": "Dell", "f8:db:88": "Dell",
  // Apple
  "3c:22:fb": "Apple", "a4:83:e7": "Apple", "f0:18:98": "Apple", "f4:0f:24": "Apple",
  "8c:85:90": "Apple", "ac:bc:32": "Apple", "b8:09:8a": "Apple", "d0:81:7a": "Apple",
  "5c:e9:1e": "Apple", "f4:f5:e8": "Apple",
  // Raspberry Pi
  "b8:27:eb": "Raspberry Pi", "dc:a6:32": "Raspberry Pi", "e4:5f:01": "Raspberry Pi",
  "28:cd:c1": "Raspberry Pi", "d8:3a:dd": "Raspberry Pi", "2c:cf:67": "Raspberry Pi",
  // Google
  "f4:f5:d8": "Google", "f0:ef:86": "Google", "a4:77:33": "Google", "e4:f0:42": "Google",
  // Amazon
  "fc:65:de": "Amazon", "44:65:0d": "Amazon", "84:d6:d0": "Amazon",
  // Microsoft
  "f4:21:ca": "Microsoft", "7c:1e:52": "Microsoft", "98:5f:d3": "Microsoft",
  // HP
  "00:1b:78": "HP", "00:1f:29": "HP", "94:57:a5": "HP", "70:5a:0f": "HP",
  // Lenovo
  "8c:16:45": "Lenovo", "54:e1:ad": "Lenovo", "a0:51:0b": "Lenovo",
  // Synology
  "00:11:32": "Synology",
  // Ubiquiti
  "24:5a:4c": "Ubiquiti", "78:8a:20": "Ubiquiti", "fc:ec:da": "Ubiquiti",
  // Philips Hue
  "00:17:88": "Philips Hue",
}

function lookupVendor(mac: string): string | null {
  const oui = mac.toLowerCase().split(":").slice(0, 3).join(":")
  return OUI_VENDORS[oui] ?? null
}

function normalizeMac(mac: string): string {
  return mac
    .split(":")
    .map((p) => p.padStart(2, "0"))
    .join(":")
    .toLowerCase()
}

interface ArpEntry {
  ip: string
  mac: string
  vendor: string | null
  hostname: string | null
}

function detectSubnet(): { iface: string; ip: string; subnet: string } | null {
  const ifaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("192.168.")) {
        const subnet = addr.address.split(".").slice(0, 3).join(".")
        return { iface: name, ip: addr.address, subnet }
      }
    }
  }
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const subnet = addr.address.split(".").slice(0, 3).join(".")
        return { iface: name, ip: addr.address, subnet }
      }
    }
  }
  return null
}

async function pingSweep(subnet: string): Promise<void> {
  // 254 pings in parallel — completes in ~2s
  await Promise.all(
    Array.from({ length: 254 }, (_, idx) => {
      const i = idx + 1
      return new Promise<void>((resolve) => {
        const p = spawn("ping", ["-c", "1", "-W", "300", "-t", "1", `${subnet}.${i}`], {
          stdio: "ignore",
        })
        const kill = setTimeout(() => p.kill("SIGKILL"), 1500)
        p.on("exit", () => { clearTimeout(kill); resolve() })
        p.on("error", () => { clearTimeout(kill); resolve() })
      })
    }),
  )
}

function readArpTable(subnet: string): ArpEntry[] {
  let raw = ""
  try {
    raw = execSync("arp -an", { encoding: "utf8", timeout: 5000 })
  } catch {
    return []
  }
  const entries: ArpEntry[] = []
  for (const line of raw.split("\n")) {
    const m = line.match(/\(([\d.]+)\)\s+at\s+([0-9a-f:]+)/i)
    if (!m) continue
    const ip = m[1]
    if (!ip.startsWith(subnet + ".")) continue
    if (ip.endsWith(".255") || ip.endsWith(".0")) continue
    if (line.includes("incomplete")) continue
    const mac = normalizeMac(m[2])
    if (mac === "ff:ff:ff:ff:ff:ff") continue
    entries.push({ ip, mac, vendor: lookupVendor(mac), hostname: null })
  }
  return entries
}

function reverseDns(ip: string): string | null {
  try {
    const out = execSync(`dig +short -x ${ip} +time=1 +tries=1`, {
      encoding: "utf8",
      timeout: 2000,
    }).trim()
    if (!out) return null
    return out.split("\n")[0].replace(/\.$/, "") || null
  } catch {
    return null
  }
}

function checkPort(ip: string, port: number, timeoutSec = 1): boolean {
  const r = spawnSync("nc", ["-z", "-G", String(timeoutSec), ip, String(port)], {
    stdio: "ignore",
    timeout: (timeoutSec + 1) * 1000,
  })
  return r.status === 0
}

function sshBanner(ip: string): string | null {
  try {
    const out = execSync(`echo "" | nc -G 2 ${ip} 22 2>/dev/null | head -1`, {
      encoding: "utf8",
      timeout: 4000,
      shell: "/bin/sh",
    }).trim()
    return out || null
  } catch {
    return null
  }
}

// ============================================================================
// scan
// ============================================================================

const HiveScanCommand = cmd({
  command: "scan",
  describe: "discover candidate Hive nodes on your local network",
  builder: (yargs) =>
    yargs
      .option("vendor", { describe: "filter by vendor (dell, apple, raspberry, etc.)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("skip-sweep", { describe: "skip ping sweep, read existing ARP cache only", type: "boolean", default: false }),
  async handler(argv) {
    const net = detectSubnet()
    if (!net) {
      console.error("Could not detect a usable network interface")
      process.exit(1)
    }

    if (!argv.json) {
      console.log(`${dim("interface:")} ${net.iface}  ${dim("ip:")} ${net.ip}  ${dim("subnet:")} ${net.subnet}.0/24`)
    }

    if (!argv["skip-sweep"]) {
      if (!argv.json) console.log(dim("priming ARP table (ping sweep)..."))
      await pingSweep(net.subnet)
    }

    let entries = readArpTable(net.subnet)

    if (argv.vendor) {
      const v = String(argv.vendor).toLowerCase()
      entries = entries.filter((e) => e.vendor?.toLowerCase().includes(v))
    }

    await Promise.all(
      entries.map((e) =>
        new Promise<void>((resolve) => {
          try { e.hostname = reverseDns(e.ip) } catch {}
          resolve()
        })
      )
    )

    if (argv.json) {
      console.log(JSON.stringify({ ...net, devices: entries }, null, 2))
      return
    }

    if (entries.length === 0) {
      console.log(dim("No devices found. Try without --no-sweep, or check your network."))
      return
    }

    entries.sort((a, b) => {
      if (!a.vendor && b.vendor) return -1
      if (a.vendor && !b.vendor) return 1
      return a.ip.localeCompare(b.ip, undefined, { numeric: true })
    })

    console.log()
    console.log(bold("  IP               MAC                Vendor           Hostname"))
    console.log(dim("  " + "─".repeat(78)))
    for (const e of entries) {
      const ip = e.ip.padEnd(16)
      const mac = e.mac.padEnd(18)
      const vendor = (e.vendor ?? dim("?")).padEnd(16)
      const host = e.hostname ?? dim("—")
      const marker = !e.vendor ? bold("•") : " "
      console.log(`${marker} ${ip} ${mac} ${vendor} ${host}`)
    }
    console.log()
    console.log(dim(`  ${entries.length} device(s).  ${bold("•")} = unknown vendor (likely candidates).`))
    console.log(dim(`  Next: iris hive probe <ip>`))
  },
})

// ============================================================================
// probe
// ============================================================================

const HiveProbeCommand = cmd({
  command: "probe <ip>",
  describe: "deep-probe a single host (ports, SSH banner, vendor, OS)",
  builder: (yargs) =>
    yargs
      .positional("ip", { describe: "IP address to probe", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const ip = String(argv.ip)
    const result: Record<string, unknown> = { ip }

    const ping = spawnSync("ping", ["-c", "2", "-W", "500", ip], { stdio: "ignore", timeout: 3000 })
    result.reachable = ping.status === 0

    try {
      const arpOut = execSync(`arp -n ${ip}`, { encoding: "utf8", timeout: 2000 })
      const m = arpOut.match(/at\s+([0-9a-f:]+)/i)
      if (m) {
        const mac = normalizeMac(m[1])
        result.mac = mac
        result.vendor = lookupVendor(mac)
      }
    } catch {}

    result.hostname = reverseDns(ip)

    const ports: Record<string, { open: boolean; service: string }> = {}
    const portList: Array<[number, string]> = [
      [22, "SSH"], [80, "HTTP"], [443, "HTTPS"], [445, "SMB"],
      [3389, "RDP"], [5900, "VNC"], [8006, "Proxmox"], [9090, "Cockpit"],
    ]
    for (const [port, service] of portList) {
      ports[String(port)] = { open: checkPort(ip, port), service }
    }
    result.ports = ports

    if (ports["22"].open) {
      const banner = sshBanner(ip)
      result.ssh_banner = banner
      if (banner) {
        if (/ubuntu/i.test(banner)) result.os_guess = "Ubuntu"
        else if (/debian/i.test(banner)) result.os_guess = "Debian"
        else if (/openssh/i.test(banner)) result.os_guess = "Linux/macOS"
      }
    }

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    console.log()
    console.log(`${bold("Host:")} ${ip}`)
    console.log(`  ${dim("reachable:")} ${result.reachable ? success("yes") : "no"}`)
    if (result.mac) console.log(`  ${dim("mac:")}       ${result.mac}${result.vendor ? "  (" + result.vendor + ")" : ""}`)
    if (result.hostname) console.log(`  ${dim("hostname:")}  ${result.hostname}`)
    if (result.os_guess) console.log(`  ${dim("os:")}        ${result.os_guess}`)
    console.log()
    console.log(bold("Ports:"))
    for (const [port, info] of Object.entries(ports)) {
      const status = info.open ? success("open") : dim("closed")
      console.log(`  ${port.padStart(5)}  ${info.service.padEnd(10)} ${status}`)
    }
    if (result.ssh_banner) {
      console.log()
      console.log(`${dim("SSH banner:")} ${result.ssh_banner}`)
    }
    if (ports["22"].open) {
      console.log()
      console.log(dim(`Next: iris hive ssh ${ip} <user>`))
    }
  },
})

// ============================================================================
// ssh
// ============================================================================

const HiveSshCommand = cmd({
  command: "ssh <ip> [user]",
  describe: "test SSH access to a host (tries common users with key auth)",
  builder: (yargs) =>
    yargs
      .positional("ip", { describe: "IP address", type: "string", demandOption: true })
      .positional("user", { describe: "specific user to try", type: "string" }),
  async handler(argv) {
    const ip = String(argv.ip)
    const users = argv.user
      ? [String(argv.user)]
      : ["ubuntu", "debian", "admin", "root", "alex", "dell", "pi", "user"]

    if (!checkPort(ip, 22)) {
      console.log(`${dim("✗")} port 22 is closed on ${ip}`)
      console.log(dim("  Enable SSH on the target first: sudo systemctl enable --now ssh"))
      return
    }

    console.log(dim(`Trying key-based auth for ${users.length} common user(s) on ${ip}...`))

    for (const u of users) {
      const r = spawnSync(
        "ssh",
        [
          "-o", "ConnectTimeout=3",
          "-o", "BatchMode=yes",
          "-o", "StrictHostKeyChecking=no",
          "-o", "PreferredAuthentications=publickey",
          `${u}@${ip}`,
          "echo SSH_OK",
        ],
        { encoding: "utf8", timeout: 5000 },
      )
      if (r.status === 0 && r.stdout.includes("SSH_OK")) {
        console.log(`${success("✓")} key auth works for ${bold(u + "@" + ip)}`)
        console.log()
        console.log(`  Connect:   ${bold(`ssh ${u}@${ip}`)}`)
        return
      }
    }

    console.log(`${dim("!")} no passwordless auth worked. Try interactively with a password:`)
    for (const u of users) {
      console.log(`  ssh ${u}@${ip}`)
    }
  },
})

export const HiveScanCommandExport = HiveScanCommand
export const HiveProbeCommandExport = HiveProbeCommand
export const HiveSshCommandExport = HiveSshCommand
