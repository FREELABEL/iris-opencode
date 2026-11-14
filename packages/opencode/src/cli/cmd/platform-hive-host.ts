import { cmd } from "./cmd"
import { dim, bold, success, highlight } from "./iris-api"
import { spawnSync } from "child_process"
import { firstArray } from "../../util/array"

// ============================================================================
// iris hive host  —  provision a secure Windows RDP host (the QB/PHI box)
//
// `iris hive vpn` gets Tailscale onto a machine you're sitting at. `iris hive
// host` drives a REMOTE Azure VM through `az vm run-command` so you never have
// to RDP in by hand to set it up. It automates the exact sequence proven on the
// #531 test box:
//
//   setup     → install Tailscale on the VM (headless, via auth key) + join tailnet
//   add-user  → create a dedicated RDP user (never the admin login) + RDP group
//   grant     → share the tailnet node with an external user (e.g. Drex)
//   lockdown  → delete the public RDP firewall rule → tunnel-only, PHI-ready
//
// Assumes the VM already exists (one-off `az vm create`) and you're logged in
// with `az login`. Every step is idempotent and re-runnable.
//
// First use case: VPN IRIS HIVE bloq #531 — a QuickBooks Desktop host on Azure,
// reachable only over Tailscale, scoped to the Drex accounting team.
// ============================================================================

/**
 * Emit the PowerShell instead of running it, for hosts Azure cannot reach.
 *
 * Everything here drives a VM through `az vm run-command`, which is excellent and only
 * works on an Azure VM you own. The same steps are exactly what a physical Windows box in
 * a back office needs — and for those there is currently no path at all, so the useful
 * automation stops at the cloud boundary for no reason other than transport.
 *
 * The script is the portable part. Printing it turns "we cannot reach that machine" into
 * "paste this into an elevated PowerShell on that machine", which is a one-time, auditable
 * step someone is already sitting in front of during setup. Deliberately NOT a new remote
 * exec path: adding WinRM or SSH credentials to reach a client's accounting host is a much
 * bigger security decision than pasting a script you can read first.
 */
function printScript(title: string, ps: string, note?: string): void {
  console.log()
  console.log(bold(title))
  console.log(dim("  Run in an ELEVATED PowerShell on that machine (Start → Windows PowerShell → Run as administrator)."))
  if (note) console.log(dim(`  ${note}`))
  console.log()
  console.log(ps)
  console.log()
  console.log(dim("  Read it before you run it — it is printed rather than executed for exactly that reason."))
  console.log()
}

// ── az CLI plumbing ──────────────────────────────────────────────────────────

function hasAz(): boolean {
  const [locator, ...args] = process.platform === "win32" ? ["where", "az"] : ["command", "-v", "az"]
  const r = spawnSync(locator, args, { shell: true, encoding: "utf8" })
  return r.status === 0 && !!r.stdout.trim()
}

function az(args: string[], timeoutSec = 240): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("az", args, { encoding: "utf8", timeout: timeoutSec * 1000 })
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

// Run a PowerShell script INSIDE the VM via the Azure agent (no RDP, no open port).
// Passing the whole script as ONE arg (no shell) sidesteps all quoting issues.
function azRunPS(rg: string, vm: string, script: string, timeoutSec = 300) {
  return az(
    [
      "vm",
      "run-command",
      "invoke",
      "--resource-group",
      rg,
      "--name",
      vm,
      "--command-id",
      "RunPowerShellScript",
      "--scripts",
      script,
      "--query",
      "value[0].message",
      "-o",
      "tsv",
    ],
    timeoutSec,
  )
}

function requireAzOrExit() {
  if (!hasAz()) {
    console.log(`${highlight("!")} Azure CLI not found. Install it: ${bold("brew install azure-cli")} then ${bold("az login")}`)
    process.exit(1)
  }
}

// ── host add-user  (dedicated RDP user — the create-haroon.ps1 logic) ─────────

const HostAddUserCommand = cmd({
  command: "add-user <vm> <user>",
  describe: "create a dedicated RDP Windows user on the VM (+ Remote Desktop group), one-time password",
  builder: (y) =>
    y
      .positional("vm", { describe: "Azure VM name — or any label, with --print-script", type: "string", demandOption: true })
      .positional("user", { describe: "Windows username to create, e.g. haroon", type: "string", demandOption: true })
      .option("resource-group", { alias: "g", describe: "Azure resource group", type: "string" })
      .option("full-name", { describe: "display name for the account", type: "string" })
      .option("print-script", { describe: "print the PowerShell to run by hand — for machines Azure cannot reach", type: "boolean", default: false }),
  async handler(argv) {
    const printOnly = Boolean(argv["print-script"])
    if (!printOnly) {
      requireAzOrExit()
      if (!argv["resource-group"]) {
        console.log(`${highlight("!")} --resource-group is required to run against an Azure VM (or use --print-script).`)
        process.exit(1)
      }
    }
    const rg = String(argv["resource-group"] ?? "")
    const vm = String(argv.vm)
    const user = String(argv.user).replace(/[^A-Za-z0-9._-]/g, "")
    const fullName = argv["full-name"] ? String(argv["full-name"]) : `${user} (Hive RDP)`

    // Strong one-time password generated ON the box; forced change at first logon.
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `$user='${user}'`,
      `$chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'`,
      `$rand=-join ((1..16) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })`,
      `$pw='Qb'+$rand+'#7'`,
      `$sec=ConvertTo-SecureString $pw -AsPlainText -Force`,
      `if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) { Set-LocalUser -Name $user -Password $sec; $status='reset-existing' }`,
      `else { New-LocalUser -Name $user -Password $sec -FullName '${fullName}' -Description 'Hive RDP access' -AccountNeverExpires | Out-Null; $status='created' }`,
      `Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $user -ErrorAction SilentlyContinue`,
      `$u=[ADSI]("WinNT://./$user,user"); $u.PasswordExpired=1; $u.SetInfo()`,
      `'STATUS='+$status`,
      `'TEMP_PASSWORD='+$pw`,
    ].join("\n")

    if (printOnly) {
      printScript(
        `Create the dedicated RDP account "${user}" on ${vm}`,
        ps,
        "It prints TEMP_PASSWORD at the end. That password is one-time — Windows forces a change at first logon.",
      )
      console.log(dim("  Give the temporary password to that person directly, not over the same channel as the host address."))
      console.log()
      return
    }

    console.log(`${dim("→")} creating Windows user ${bold(user)} on ${bold(vm)} ${dim("(via az run-command)…")}`)
    const r = azRunPS(rg, vm, ps)
    if (!r.ok) {
      console.log(`${highlight("✗")} failed: ${dim((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "))}`)
      process.exit(1)
    }
    const pw = /TEMP_PASSWORD=(\S+)/.exec(r.stdout)?.[1]
    const status = /STATUS=(\S+)/.exec(r.stdout)?.[1] ?? "done"
    console.log()
    console.log(`${success("✓")} user ${bold(user)} ${dim("(" + status + ")")} — in the Remote Desktop Users group`)
    if (pw) {
      console.log(`  ${dim("one-time password:")}  ${bold(pw)}`)
      console.log(dim(`  Deliver over a secure channel; they must change it at first logon.`))
    }
    console.log()
  },
})

// ── host setup  (install Tailscale on the VM, headless via auth key) ──────────

const HostSetupCommand = cmd({
  command: "setup <vm>",
  describe: "install Tailscale on the VM and join the tailnet (headless, via auth key)",
  builder: (y) =>
    y
      .positional("vm", { describe: "Azure VM name — or any label, with --print-script", type: "string", demandOption: true })
      .option("resource-group", { alias: "g", describe: "Azure resource group", type: "string" })
      .option("authkey", { describe: "Tailscale auth key (login.tailscale.com/admin/settings/keys)", type: "string", demandOption: true })
      .option("hostname", { describe: "tailnet hostname (defaults to the VM name)", type: "string" })
      .option("print-script", { describe: "print the PowerShell to run by hand — for machines Azure cannot reach", type: "boolean", default: false }),
  async handler(argv) {
    const printOnly = Boolean(argv["print-script"])
    // --print-script needs neither the az CLI nor a resource group: the whole point is a
    // machine Azure does not know about. Requiring either would refuse the case it exists for.
    if (!printOnly) {
      requireAzOrExit()
      if (!argv["resource-group"]) {
        console.log(`${highlight("!")} --resource-group is required to run against an Azure VM (or use --print-script).`)
        process.exit(1)
      }
    }
    const rg = String(argv["resource-group"] ?? "")
    const vm = String(argv.vm)
    const authkey = String(argv.authkey)
    const hostname = argv.hostname ? String(argv.hostname) : vm
    if (!/^tskey-/.test(authkey)) {
      console.log(`${highlight("!")} that doesn't look like a Tailscale auth key (expected tskey-…).`)
      process.exit(1)
    }

    // Download the stable MSI, install silently, then `tailscale up` unattended.
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `$msi=Join-Path $env:TEMP 'tailscale-setup.msi'`,
      `Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi -UseBasicParsing`,
      `Start-Process msiexec.exe -ArgumentList @('/i', $msi, '/quiet', '/norestart') -Wait`,
      `$ts='C:\\Program Files\\Tailscale\\tailscale.exe'`,
      `& $ts up --authkey=${authkey} --hostname=${hostname} --unattended`,
      `Start-Sleep -Seconds 3`,
      `'TAILNET_IP='+(& $ts ip -4 | Select-Object -First 1)`,
    ].join("\n")

    if (printOnly) {
      printScript(
        `Install Tailscale on ${vm} and join the tailnet as ${hostname}`,
        ps,
        "The auth key below is single-use and short-lived — mint a fresh one if this sits around.",
      )
      console.log(dim(`  Then, back here:  iris hive vpn status   ${dim("(the host should appear)")}`))
      console.log()
      return
    }

    console.log(`${dim("→")} installing Tailscale on ${bold(vm)} + joining tailnet as ${bold(hostname)} ${dim("(this takes ~1 min)…")}`)
    const r = azRunPS(rg, vm, ps, 360)
    if (!r.ok) {
      console.log(`${highlight("✗")} failed: ${dim((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "))}`)
      process.exit(1)
    }
    const ip = /TAILNET_IP=(100\.\S+)/.exec(r.stdout)?.[1]
    console.log()
    console.log(`${success("✓")} Tailscale installed + joined the tailnet`)
    if (ip) {
      console.log(`  ${dim("tailnet IP:")}   ${bold(ip)}`)
      console.log(`  ${dim("RDP address:")}  ${bold(ip + ":3389")}`)
    }
    console.log(dim(`  Next: iris hive host add-user ${vm} <user> -g ${rg}   then   iris hive host lockdown ${vm} -g ${rg}`))
    console.log()
  },
})

// ── host grant  (share the tailnet node with an external user) ────────────────

const HostGrantCommand = cmd({
  command: "grant <email>",
  describe: "share the tailnet host with an external user (e.g. a Drex accountant) — least-privilege",
  builder: (y) =>
    y
      .positional("email", { describe: "the external user's email to share the node with", type: "string", demandOption: true })
      .option("machine", { describe: "tailnet machine name to share, e.g. qb-host-vanguard", type: "string", demandOption: true }),
  async handler(argv) {
    const email = String(argv.email)
    const machine = String(argv.machine)
    // Node sharing is an admin-console / API action tied to your tailnet identity,
    // so we guide it precisely rather than guessing credentials. This keeps the
    // external user OFF your tailnet — they get exactly one machine, nothing else.
    console.log()
    console.log(bold(`Share ${machine} with ${email}`) + dim("  (external node share — not a full tailnet member)"))
    console.log()
    console.log(`  1. Open ${bold("https://login.tailscale.com/admin/machines")}`)
    console.log(`  2. Find ${bold(machine)} → ${bold("⋯")} → ${bold("Share…")}`)
    console.log(`  3. Enter ${bold(email)} → copy the invite link → send it to them`)
    console.log(`  4. They accept, install Tailscale, and can reach ${bold(machine + ":3389")} — and nothing else.`)
    console.log()
    console.log(dim(`  Off-boarding: same screen → remove the share → access gone immediately.`))
    console.log(dim(`  Group-based alternative (Google Workspace ACL): iris hive vpn grant <group> <tag>`))
    console.log()
  },
})

// ── host lockdown  (delete the public RDP rule → tunnel-only) ─────────────────

const HostLockdownCommand = cmd({
  command: "lockdown <vm>",
  describe: "delete the public RDP firewall rule on the VM's NSG → reachable only over Tailscale",
  builder: (y) =>
    y
      .positional("vm", { describe: "Azure VM name", type: "string", demandOption: true })
      .option("resource-group", { alias: "g", describe: "Azure resource group", type: "string", demandOption: true })
      .option("nsg", { describe: "network security group name (defaults to <vm>-nsg)", type: "string" })
      .option("yes", { describe: "skip the confirmation prompt", type: "boolean", default: false }),
  async handler(argv) {
    requireAzOrExit()
    const rg = String(argv["resource-group"])
    const vm = String(argv.vm)
    const nsg = argv.nsg ? String(argv.nsg) : `${vm}-nsg`

    const list = az(["network", "nsg", "rule", "list", "-g", rg, "--nsg-name", nsg, "-o", "json"])
    if (!list.ok) {
      console.log(`${highlight("✗")} couldn't read NSG ${bold(nsg)}: ${dim((list.stderr || "").trim().split("\n").slice(-2).join(" "))}`)
      console.log(dim(`  Pass the right one with --nsg <name>.`))
      process.exit(1)
    }
    let rules: any[] = []
    try {
      rules = JSON.parse(list.stdout)
    } catch {
      /* leave empty */
    }
    const opensRdp = (r: any) => {
      const one = r?.destinationPortRange
      const many: string[] = firstArray(r?.destinationPortRanges)
      return one === "3389" || one === "*" || many.includes("3389") || many.includes("*")
    }
    const publicRdp = rules.filter(
      (r) => r?.access === "Allow" && r?.direction === "Inbound" && opensRdp(r),
    )

    if (publicRdp.length === 0) {
      console.log(`${success("✓")} no public RDP allow-rules on ${bold(nsg)} — already locked down.`)
      return
    }

    console.log()
    console.log(bold(`Public RDP rules on ${nsg} that will be DELETED:`))
    for (const r of publicRdp) {
      console.log(`  ${highlight("•")} ${bold(r.name)}  ${dim(`prio ${r.priority} · src ${(Array.isArray(r.sourceAddressPrefixes) && r.sourceAddressPrefixes.length ? r.sourceAddressPrefixes.join(",") : r.sourceAddressPrefix) || "*"}`)}`)
    }
    console.log()

    if (!argv.yes) {
      console.log(highlight(`  Re-run with ${bold("--yes")} to delete these and go tunnel-only.`))
      console.log(dim(`  (Make sure you can already RDP over the Tailscale 100.x IP first!)`))
      return
    }

    let failed = 0
    for (const r of publicRdp) {
      const d = az(["network", "nsg", "rule", "delete", "-g", rg, "--nsg-name", nsg, "-n", r.name])
      if (d.ok) console.log(`  ${success("✓")} deleted ${bold(r.name)}`)
      else {
        failed++
        console.log(`  ${highlight("✗")} failed to delete ${bold(r.name)}`)
      }
    }
    console.log()
    console.log(failed === 0 ? success(`  locked down — ${vm} is now Tailscale-only`) : highlight(`  ${failed} rule(s) failed to delete`))
    console.log()
    if (failed > 0) process.exit(1)
  },
})

// ── group command ─────────────────────────────────────────────────────────────

export const HiveHostCommandExport = cmd({
  command: "host <subcommand>",
  describe: "provision a secure remote RDP host (Azure VM): setup · add-user · grant · lockdown",
  builder: (y) =>
    y
      .command(HostSetupCommand)
      .command(HostAddUserCommand)
      .command(HostGrantCommand)
      .command(HostLockdownCommand)
      .demandCommand(1, "Run one of: setup · add-user · grant · lockdown"),
  handler() {},
})
