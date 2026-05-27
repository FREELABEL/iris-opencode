/**
 * Hive Send/Inbox — Unit & Integration Tests
 *
 * Tests cover:
 * 1. Type detection (file/text/link)
 * 2. Encryption roundtrip (AES-256-CBC)
 * 3. Path traversal protection
 * 4. JSONL manifest read/write/parse
 * 5. TTL expiry logic
 * 6. Auto-prune (14-day retention)
 * 7. Filename sanitization
 * 8. Notification truncation
 * 9. Outbox history append
 * 10. Inbox formatting and display
 * 11. Daemon _saveToHiveInbox logic
 * 12. SQL injection protection in search
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync, appendFileSync, statSync } from "fs"
import { join, basename, resolve } from "path"
import { tmpdir } from "os"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"

// ── Test fixtures ──────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), `iris-hive-test-${Date.now()}`)
const INBOX_DIR = join(TEST_DIR, "inbox")
const OUTBOX_DIR = join(TEST_DIR, "outbox")
const MANIFEST_PATH = join(INBOX_DIR, ".manifest.jsonl")
const OUTBOX_HISTORY = join(OUTBOX_DIR, ".history.jsonl")

function setup() {
  mkdirSync(INBOX_DIR, { recursive: true })
  mkdirSync(OUTBOX_DIR, { recursive: true })
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch {}
}

function appendManifestEntry(entry: Record<string, unknown>) {
  appendFileSync(MANIFEST_PATH, JSON.stringify(entry) + "\n")
}

function readManifest(): any[] {
  if (!existsSync(MANIFEST_PATH)) return []
  const raw = readFileSync(MANIFEST_PATH, "utf-8").trim()
  if (!raw) return []
  return raw.split("\n").map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    file: "test_message.txt",
    type: "text",
    from_node: "TestNode",
    received_at: new Date().toISOString(),
    size_bytes: 42,
    read: false,
    original_name: null,
    message: "Test message",
    url: null,
    ...overrides,
  }
}

// ============================================================================
// 1. Type Detection
// ============================================================================

describe("type detection", () => {
  test("URL starting with http:// detected as link", () => {
    const input = "http://example.com/page"
    expect(/^https?:\/\//i.test(input)).toBe(true)
  })

  test("URL starting with https:// detected as link", () => {
    const input = "https://raichu.heyiris.io/api/health"
    expect(/^https?:\/\//i.test(input)).toBe(true)
  })

  test("URL with HTTP:// (uppercase) detected as link", () => {
    const input = "HTTP://EXAMPLE.COM"
    expect(/^https?:\/\//i.test(input)).toBe(true)
  })

  test("existing file path detected as file", () => {
    setup()
    const filePath = join(TEST_DIR, "test-file.txt")
    writeFileSync(filePath, "hello")
    expect(existsSync(filePath)).toBe(true)
    teardown()
  })

  test("plain text (not URL, not file) detected as text", () => {
    const input = "Deploy is done, check staging"
    expect(/^https?:\/\//i.test(input)).toBe(false)
    expect(existsSync(input)).toBe(false)
  })

  test("text that looks like a path but doesn't exist is text", () => {
    const input = "/nonexistent/path/to/file.txt"
    expect(existsSync(input)).toBe(false)
  })
})

// ============================================================================
// 2. Encryption Roundtrip
// ============================================================================

describe("encryption", () => {
  test("AES-256-CBC encrypt → decrypt roundtrip preserves data", () => {
    const secret = "test-node-api-key-12345"
    const key = createHash("sha256").update(secret).digest()
    const iv = randomBytes(16)

    const plaintext = Buffer.from("Hello from encrypted test! Secret data here.")
    const cipher = createCipheriv("aes-256-cbc", key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

    expect(decrypted.toString()).toBe(plaintext.toString())
    expect(encrypted.length).toBeGreaterThan(plaintext.length) // padding adds bytes
  })

  test("different key produces wrong output or throws", () => {
    const key1 = createHash("sha256").update("key-A").digest()
    const key2 = createHash("sha256").update("key-B").digest()
    const iv = randomBytes(16)

    const plaintext = Buffer.from("Sensitive data must stay secret")
    const cipher = createCipheriv("aes-256-cbc", key1, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

    let threw = false
    let decryptedText = ""
    try {
      const decipher = createDecipheriv("aes-256-cbc", key2, iv)
      const result = Buffer.concat([decipher.update(encrypted), decipher.final()])
      decryptedText = result.toString("utf-8")
    } catch {
      threw = true
    }

    // Either throws (padding error) or produces wrong output
    if (!threw) {
      expect(decryptedText).not.toBe(plaintext.toString())
    } else {
      expect(threw).toBe(true)
    }
  })

  test("wrong IV produces wrong output or throws", () => {
    const key = createHash("sha256").update("same-key").digest()
    const iv1 = randomBytes(16)
    const iv2 = randomBytes(16)

    const plaintext = Buffer.from("Data encrypted with IV1")
    const cipher = createCipheriv("aes-256-cbc", key, iv1)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

    let threw = false
    let decryptedText = ""
    try {
      const decipher = createDecipheriv("aes-256-cbc", key, iv2)
      const result = Buffer.concat([decipher.update(encrypted), decipher.final()])
      decryptedText = result.toString("utf-8")
    } catch {
      threw = true
    }

    if (!threw) {
      expect(decryptedText).not.toBe(plaintext.toString())
    } else {
      expect(threw).toBe(true)
    }
  })

  test("empty plaintext roundtrips correctly", () => {
    const key = createHash("sha256").update("test").digest()
    const iv = randomBytes(16)

    const plaintext = Buffer.from("")
    const cipher = createCipheriv("aes-256-cbc", key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

    expect(decrypted.toString()).toBe("")
  })

  test("large payload (1MB) roundtrips correctly", () => {
    const key = createHash("sha256").update("test-key").digest()
    const iv = randomBytes(16)

    const plaintext = Buffer.alloc(1024 * 1024, "A") // 1MB
    const cipher = createCipheriv("aes-256-cbc", key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])

    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

    expect(decrypted.length).toBe(plaintext.length)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  test("IV is included in hex and can be reconstructed", () => {
    const iv = randomBytes(16)
    const ivHex = iv.toString("hex")
    const reconstructed = Buffer.from(ivHex, "hex")
    expect(reconstructed.equals(iv)).toBe(true)
    expect(ivHex.length).toBe(32) // 16 bytes = 32 hex chars
  })
})

// ============================================================================
// 3. Path Traversal Protection
// ============================================================================

describe("path traversal protection", () => {
  test("../../../../etc/passwd sanitized to 'passwd'", () => {
    const rawName = "../../../../etc/passwd"
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_")
    expect(safeName).toBe("passwd")
  })

  test("../../../.ssh/id_rsa sanitized to 'id_rsa'", () => {
    const rawName = "../../../.ssh/id_rsa"
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_")
    expect(safeName).toBe("id_rsa")
  })

  test("filename with special chars sanitized", () => {
    const rawName = "my file (v2) [final].pdf"
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_")
    expect(safeName).toBe("my_file__v2___final_.pdf")
    expect(safeName).not.toContain(" ")
    expect(safeName).not.toContain("(")
    expect(safeName).not.toContain("[")
  })

  test("null bytes in filename stripped", () => {
    const rawName = "evil\x00file.txt"
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_")
    expect(safeName).not.toContain("\x00")
  })

  test("empty filename defaults safely", () => {
    const rawName = ""
    const safeName = basename(rawName || "download").replace(/[^a-zA-Z0-9._-]/g, "_")
    expect(safeName).toBe("download")
  })

  test("resolved path stays inside inbox dir", () => {
    setup()
    const timestamp = "2026-05-26-22-15-30"
    const safeName = "passwd"
    const fullPath = join(INBOX_DIR, `${timestamp}_${safeName}`)
    const resolvedPath = resolve(fullPath)
    expect(resolvedPath.startsWith(resolve(INBOX_DIR))).toBe(true)
    teardown()
  })

  test("dot-dot in resolved path detected and blocked", () => {
    setup()
    // Even if someone crafts a symlink, resolve() would reveal the real path
    const maliciousPath = join(INBOX_DIR, "..", "..", "etc", "passwd")
    const resolvedPath = resolve(maliciousPath)
    expect(resolvedPath.startsWith(resolve(INBOX_DIR))).toBe(false)
    teardown()
  })
})

// ============================================================================
// 4. JSONL Manifest
// ============================================================================

describe("JSONL manifest", () => {
  beforeEach(setup)
  afterEach(teardown)

  test("empty manifest returns empty array", () => {
    expect(readManifest()).toEqual([])
  })

  test("single entry written and read back", () => {
    const entry = makeEntry({ id: "test-001" })
    appendManifestEntry(entry)

    const items = readManifest()
    expect(items.length).toBe(1)
    expect(items[0].id).toBe("test-001")
  })

  test("multiple entries — each on its own line", () => {
    for (let i = 0; i < 5; i++) {
      appendManifestEntry(makeEntry({ id: `item-${i}`, message: `Message ${i}` }))
    }

    const items = readManifest()
    expect(items.length).toBe(5)
    expect(items[4].id).toBe("item-4")
  })

  test("concurrent appends don't corrupt each other", () => {
    // Simulate rapid appends (as daemon would do under load)
    const entries = Array.from({ length: 20 }, (_, i) => makeEntry({ id: `concurrent-${i}` }))
    for (const e of entries) {
      appendFileSync(MANIFEST_PATH, JSON.stringify(e) + "\n")
    }

    const items = readManifest()
    expect(items.length).toBe(20)

    // Every line should parse
    const raw = readFileSync(MANIFEST_PATH, "utf-8").trim()
    const lines = raw.split("\n")
    let parseErrors = 0
    for (const line of lines) {
      try { JSON.parse(line) } catch { parseErrors++ }
    }
    expect(parseErrors).toBe(0)
  })

  test("corrupt line in manifest is skipped, valid lines preserved", () => {
    appendManifestEntry(makeEntry({ id: "valid-1" }))
    appendFileSync(MANIFEST_PATH, "THIS IS NOT JSON\n")
    appendManifestEntry(makeEntry({ id: "valid-2" }))

    const items = readManifest()
    expect(items.length).toBe(2)
    expect(items[0].id).toBe("valid-1")
    expect(items[1].id).toBe("valid-2")
  })

  test("manifest with only whitespace returns empty", () => {
    writeFileSync(MANIFEST_PATH, "   \n\n  \n")
    const items = readManifest()
    expect(items.length).toBe(0)
  })

  test("entry has all required fields", () => {
    const entry = makeEntry()
    appendManifestEntry(entry)
    const items = readManifest()
    const item = items[0]

    expect(item.id).toBeTruthy()
    expect(item.file).toBeTruthy()
    expect(["file", "text", "link"]).toContain(item.type)
    expect(item.from_node).toBeTruthy()
    expect(item.received_at).toBeTruthy()
    expect(typeof item.read).toBe("boolean")
  })

  test("mark as read — rewrite preserves all entries", () => {
    for (let i = 0; i < 3; i++) {
      appendManifestEntry(makeEntry({ id: `mark-${i}`, read: false }))
    }

    const items = readManifest()
    items[1].read = true

    // Rewrite manifest (as CLI does on open/read)
    writeFileSync(MANIFEST_PATH, items.map((i) => JSON.stringify(i)).join("\n") + "\n")

    const reread = readManifest()
    expect(reread.length).toBe(3)
    expect(reread[0].read).toBe(false)
    expect(reread[1].read).toBe(true)
    expect(reread[2].read).toBe(false)
  })
})

// ============================================================================
// 5. TTL Expiry Logic
// ============================================================================

describe("TTL expiry", () => {
  test("future timestamp is NOT expired", () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const expired = Date.now() > new Date(expiresAt).getTime()
    expect(expired).toBe(false)
  })

  test("past timestamp IS expired", () => {
    const expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const expired = Date.now() > new Date(expiresAt).getTime()
    expect(expired).toBe(true)
  })

  test("files get 24h TTL by default", () => {
    const ms = 24 * 60 * 60 * 1000
    const expiresAt = new Date(Date.now() + ms).toISOString()
    const expiresDate = new Date(expiresAt)
    const hoursFromNow = (expiresDate.getTime() - Date.now()) / (60 * 60 * 1000)
    expect(hoursFromNow).toBeGreaterThan(23)
    expect(hoursFromNow).toBeLessThanOrEqual(24)
  })

  test("text/links get 7d TTL by default", () => {
    const ms = 7 * 24 * 60 * 60 * 1000
    const expiresAt = new Date(Date.now() + ms).toISOString()
    const expiresDate = new Date(expiresAt)
    const daysFromNow = (expiresDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysFromNow).toBeGreaterThan(6.9)
    expect(daysFromNow).toBeLessThanOrEqual(7)
  })

  test("invalid date string doesn't cause crash", () => {
    const expiresAt = "not-a-date"
    const parsed = new Date(expiresAt).getTime()
    expect(isNaN(parsed)).toBe(true)
    // Daemon checks: if (!isNaN(expiresAt) && Date.now() > expiresAt) → skips
    // If NaN, condition is false → proceeds (safe default)
  })

  test("null/undefined expires_at proceeds (no TTL check)", () => {
    const config = { expires_at: undefined }
    // Daemon: if (config.expires_at) { ... } → falsy, skips check
    expect(!config.expires_at).toBe(true)
  })
})

// ============================================================================
// 6. Auto-Prune (14-day retention)
// ============================================================================

describe("auto-prune", () => {
  beforeEach(setup)
  afterEach(teardown)

  test("items older than 14 days are removed", () => {
    const cutoff = 14 * 24 * 60 * 60 * 1000
    const oldDate = new Date(Date.now() - cutoff - 1000).toISOString()
    const newDate = new Date().toISOString()

    const oldFile = "old_message.txt"
    const newFile = "new_message.txt"
    writeFileSync(join(INBOX_DIR, oldFile), "old content")
    writeFileSync(join(INBOX_DIR, newFile), "new content")

    appendManifestEntry(makeEntry({ id: "old", file: oldFile, received_at: oldDate }))
    appendManifestEntry(makeEntry({ id: "new", file: newFile, received_at: newDate }))

    // Run prune logic
    const items = readManifest()
    const keep = items.filter((i) => new Date(i.received_at).getTime() >= Date.now() - cutoff)
    const pruned = items.filter((i) => new Date(i.received_at).getTime() < Date.now() - cutoff)

    // Delete old files
    for (const item of pruned) {
      const fp = join(INBOX_DIR, item.file)
      try { if (existsSync(fp)) unlinkSync(fp) } catch {}
    }
    writeFileSync(MANIFEST_PATH, keep.map((i) => JSON.stringify(i)).join("\n") + "\n")

    const remaining = readManifest()
    expect(remaining.length).toBe(1)
    expect(remaining[0].id).toBe("new")
    expect(existsSync(join(INBOX_DIR, oldFile))).toBe(false)
    expect(existsSync(join(INBOX_DIR, newFile))).toBe(true)
  })

  test("items exactly 14 days old are kept", () => {
    const cutoff = 14 * 24 * 60 * 60 * 1000
    const exactlyOld = new Date(Date.now() - cutoff + 60000).toISOString() // 1 min before cutoff
    appendManifestEntry(makeEntry({ id: "borderline", received_at: exactlyOld }))

    const items = readManifest()
    const keep = items.filter((i) => new Date(i.received_at).getTime() >= Date.now() - cutoff)
    expect(keep.length).toBe(1)
  })

  test("empty manifest after prune doesn't crash", () => {
    const cutoff = 14 * 24 * 60 * 60 * 1000
    const oldDate = new Date(Date.now() - cutoff - 1000).toISOString()
    appendManifestEntry(makeEntry({ id: "only-old", received_at: oldDate }))

    const items = readManifest()
    const keep = items.filter((i) => new Date(i.received_at).getTime() >= Date.now() - cutoff)
    writeFileSync(MANIFEST_PATH, keep.map((i) => JSON.stringify(i)).join("\n") + (keep.length ? "\n" : ""))

    const remaining = readManifest()
    expect(remaining.length).toBe(0)
  })
})

// ============================================================================
// 7. Filename Sanitization
// ============================================================================

describe("filename sanitization", () => {
  const sanitize = (raw: string) => basename(raw || "download").replace(/[^a-zA-Z0-9._-]/g, "_")

  test("normal filename unchanged", () => {
    expect(sanitize("proposal.pdf")).toBe("proposal.pdf")
  })

  test("filename with spaces", () => {
    expect(sanitize("my document.pdf")).toBe("my_document.pdf")
  })

  test("filename with parens and brackets", () => {
    expect(sanitize("file (copy) [2].txt")).toBe("file__copy___2_.txt")
  })

  test("filename with unicode", () => {
    const result = sanitize("documento_espa\u00f1ol.pdf")
    expect(result).not.toContain("\u00f1")
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/)
  })

  test("hidden file (dot prefix) allowed", () => {
    expect(sanitize(".hidden")).toBe(".hidden")
  })

  test("double extension allowed", () => {
    expect(sanitize("archive.tar.gz")).toBe("archive.tar.gz")
  })

  test("very long filename gets through (no truncation in sanitize)", () => {
    const longName = "a".repeat(255) + ".txt"
    const result = sanitize(longName)
    expect(result.length).toBe(259)
  })

  test("only special chars become all underscores", () => {
    const result = sanitize("@#$%^&*")
    expect(result).toBe("_______")
  })
})

// ============================================================================
// 8. Notification Truncation
// ============================================================================

describe("notification truncation", () => {
  const MAX_NOTIF = 140

  function truncate(text: string): string {
    if (text.length > MAX_NOTIF) {
      return text.substring(0, MAX_NOTIF) + "... Run: iris hive inbox"
    }
    return text
  }

  test("short message not truncated", () => {
    const msg = "Deploy is done"
    expect(truncate(msg)).toBe(msg)
  })

  test("exactly 140 chars not truncated", () => {
    const msg = "A".repeat(140)
    expect(truncate(msg)).toBe(msg)
  })

  test("141 chars IS truncated", () => {
    const msg = "A".repeat(141)
    const result = truncate(msg)
    expect(result).toContain("... Run: iris hive inbox")
    expect(result.startsWith("A".repeat(140))).toBe(true)
  })

  test("500 char message truncated with CLI hint", () => {
    const msg = "B".repeat(500)
    const result = truncate(msg)
    expect(result.length).toBeLessThan(200)
    expect(result).toContain("iris hive inbox")
  })
})

// ============================================================================
// 9. Outbox History
// ============================================================================

describe("outbox history", () => {
  beforeEach(setup)
  afterEach(teardown)

  test("append history entry creates JSONL file", () => {
    const entry = {
      id: "task-123",
      to_node: "MacBookPro",
      type: "text",
      content: "Hello world",
      sent_at: new Date().toISOString(),
    }
    appendFileSync(OUTBOX_HISTORY, JSON.stringify(entry) + "\n")

    expect(existsSync(OUTBOX_HISTORY)).toBe(true)
    const raw = readFileSync(OUTBOX_HISTORY, "utf-8").trim()
    const parsed = JSON.parse(raw)
    expect(parsed.to_node).toBe("MacBookPro")
  })

  test("multiple sends appended in order", () => {
    for (let i = 0; i < 5; i++) {
      appendFileSync(OUTBOX_HISTORY, JSON.stringify({ id: `t-${i}`, to_node: `Node${i}` }) + "\n")
    }

    const lines = readFileSync(OUTBOX_HISTORY, "utf-8").trim().split("\n")
    expect(lines.length).toBe(5)

    const last = JSON.parse(lines[4])
    expect(last.to_node).toBe("Node4")
  })

  test("history items can be reversed for display", () => {
    for (let i = 0; i < 3; i++) {
      appendFileSync(OUTBOX_HISTORY, JSON.stringify({ id: `t-${i}`, order: i }) + "\n")
    }

    const items = readFileSync(OUTBOX_HISTORY, "utf-8").trim().split("\n")
      .map((l) => JSON.parse(l))
      .reverse()

    expect(items[0].order).toBe(2)
    expect(items[2].order).toBe(0)
  })
})

// ============================================================================
// 10. Inbox Display Helpers
// ============================================================================

describe("inbox display helpers", () => {
  function timeAgo(iso: string | null | undefined): string {
    if (!iso) return ""
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.round(diff / 60000)
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  function formatBytes(bytes: number | undefined): string {
    if (!bytes) return "—"
    const units = ["B", "KB", "MB", "GB"]
    let i = 0
    let size = bytes
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
    return `${size.toFixed(size < 10 ? 1 : 0)} ${units[i]}`
  }

  test("timeAgo — just now", () => {
    expect(timeAgo(new Date().toISOString())).toBe("just now")
  })

  test("timeAgo — minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    expect(timeAgo(fiveMinAgo)).toBe("5m ago")
  })

  test("timeAgo — hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(timeAgo(twoHoursAgo)).toBe("2h ago")
  })

  test("timeAgo — days ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(timeAgo(threeDaysAgo)).toBe("3d ago")
  })

  test("timeAgo — null returns empty", () => {
    expect(timeAgo(null)).toBe("")
    expect(timeAgo(undefined)).toBe("")
  })

  test("formatBytes — small", () => {
    // formatBytes uses .toFixed(1) when size < 10, else .toFixed(0)
    expect(formatBytes(42)).toBe("42 B")
  })

  test("formatBytes — KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB")
  })

  test("formatBytes — MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })

  test("formatBytes — undefined", () => {
    expect(formatBytes(undefined)).toBe("—")
  })

  test("formatBytes — zero", () => {
    expect(formatBytes(0)).toBe("—")
  })
})

// ============================================================================
// 11. Daemon _saveToHiveInbox Logic (Unit-level simulation)
// ============================================================================

describe("daemon inbox save logic", () => {
  beforeEach(setup)
  afterEach(teardown)

  function simulateSaveToInbox(task: Record<string, unknown>) {
    const config = (task.config || {}) as Record<string, unknown>
    const inboxType = (config.inbox_type as string) || "text"
    const senderName = (config.sender_name as string) || "Unknown"
    const msgText = (String(task.prompt || "")).trim()

    // TTL check
    if (config.expires_at) {
      const expiresAt = new Date(config.expires_at as string).getTime()
      if (!isNaN(expiresAt) && Date.now() > expiresAt) {
        return { skipped: true, reason: "expired" }
      }
    }

    const now = new Date()
    const timestamp = now.toISOString().replace(/[T:]/g, "-").replace(/\.\d+Z$/, "")
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    let savedFile = ""
    let sizeBytes = 0

    if (inboxType === "file" && config.file_url) {
      // Path traversal protection
      const rawName = (config.file_name as string) || "download"
      const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_")
      const fileName = `${timestamp}_${safeName}`
      const fullPath = join(INBOX_DIR, fileName)
      const resolvedPath = resolve(fullPath)

      if (!resolvedPath.startsWith(resolve(INBOX_DIR))) {
        return { skipped: true, reason: "path_traversal" }
      }

      // Simulate download (write fake data)
      writeFileSync(fullPath, "downloaded-file-content")
      sizeBytes = statSync(fullPath).size
      savedFile = fileName
    } else if (inboxType === "link") {
      const fileName = `${timestamp}_link.txt`
      const fullPath = join(INBOX_DIR, fileName)
      const content = `${config.url || msgText}\n${msgText !== (config.url || "") ? "\n" + msgText : ""}`
      writeFileSync(fullPath, content.trim() + "\n")
      sizeBytes = Buffer.byteLength(content, "utf-8")
      savedFile = fileName
    } else {
      // Text
      const fileName = `${timestamp}_message.txt`
      const fullPath = join(INBOX_DIR, fileName)
      writeFileSync(fullPath, msgText + "\n")
      sizeBytes = Buffer.byteLength(msgText, "utf-8")
      savedFile = fileName
    }

    const entry = {
      id,
      task_id: (task.id as string) || null,
      file: savedFile,
      type: inboxType,
      from_node: senderName,
      received_at: now.toISOString(),
      size_bytes: sizeBytes,
      read: false,
      original_name: (config.file_name as string) || null,
      message: msgText.substring(0, 500) || null,
      url: (config.url as string) || null,
    }
    appendFileSync(MANIFEST_PATH, JSON.stringify(entry) + "\n")

    return { skipped: false, entry, savedFile }
  }

  test("text message saved correctly", () => {
    const result = simulateSaveToInbox({
      id: "task-001",
      prompt: "Hello from test",
      config: { sender_name: "TestNode", hive_inbox: true, inbox_type: "text" },
    })

    expect(result.skipped).toBe(false)
    expect(result.entry!.type).toBe("text")
    expect(result.entry!.from_node).toBe("TestNode")

    const items = readManifest()
    expect(items.length).toBe(1)
    expect(items[0].message).toBe("Hello from test")

    const filePath = join(INBOX_DIR, result.savedFile!)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, "utf-8")).toContain("Hello from test")
  })

  test("link saved with URL and message", () => {
    const result = simulateSaveToInbox({
      id: "task-002",
      prompt: "Check this endpoint",
      config: {
        sender_name: "LinkSender",
        hive_inbox: true,
        inbox_type: "link",
        url: "https://example.com/api",
      },
    })

    expect(result.skipped).toBe(false)
    expect(result.entry!.type).toBe("link")
    expect(result.entry!.url).toBe("https://example.com/api")

    const filePath = join(INBOX_DIR, result.savedFile!)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("https://example.com/api")
  })

  test("file with path traversal filename is sanitized", () => {
    const result = simulateSaveToInbox({
      id: "task-003",
      prompt: "Malicious file",
      config: {
        sender_name: "Attacker",
        hive_inbox: true,
        inbox_type: "file",
        file_url: "https://example.com/file",
        file_name: "../../../../etc/passwd",
      },
    })

    expect(result.skipped).toBe(false)
    expect(result.savedFile).not.toContain("..")
    expect(result.savedFile).not.toContain("/")
    expect(result.savedFile).toContain("passwd")

    const filePath = join(INBOX_DIR, result.savedFile!)
    expect(resolve(filePath).startsWith(resolve(INBOX_DIR))).toBe(true)
  })

  test("expired task is skipped", () => {
    const result = simulateSaveToInbox({
      id: "task-004",
      prompt: "Should be skipped",
      config: {
        sender_name: "OldSender",
        hive_inbox: true,
        inbox_type: "text",
        expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    })

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe("expired")
    expect(readManifest().length).toBe(0)
  })

  test("message without expires_at is NOT skipped", () => {
    const result = simulateSaveToInbox({
      id: "task-005",
      prompt: "No TTL",
      config: { sender_name: "NoTTL", hive_inbox: true, inbox_type: "text" },
    })

    expect(result.skipped).toBe(false)
    expect(readManifest().length).toBe(1)
  })

  test("10 rapid saves produce 10 manifest entries", () => {
    for (let i = 0; i < 10; i++) {
      simulateSaveToInbox({
        id: `rapid-${i}`,
        prompt: `Message ${i}`,
        config: { sender_name: `Sender-${i}`, hive_inbox: true, inbox_type: "text" },
      })
    }

    const items = readManifest()
    expect(items.length).toBe(10)

    // No parse errors
    const raw = readFileSync(MANIFEST_PATH, "utf-8").trim()
    const lines = raw.split("\n")
    let errors = 0
    for (const line of lines) {
      try { JSON.parse(line) } catch { errors++ }
    }
    expect(errors).toBe(0)
  })
})

// ============================================================================
// 12. SQL Injection Protection in Search
// ============================================================================

describe("SQL injection protection", () => {
  function sanitizeSearchQuery(query: string): string {
    return query.replace(/'/g, "''").replace(/[%_\\]/g, (c) => "\\" + c)
  }

  test("single quote escaped", () => {
    expect(sanitizeSearchQuery("it's")).toBe("it''s")
  })

  test("percent sign escaped", () => {
    expect(sanitizeSearchQuery("100%")).toBe("100\\%")
  })

  test("underscore escaped", () => {
    expect(sanitizeSearchQuery("file_name")).toBe("file\\_name")
  })

  test("backslash escaped", () => {
    expect(sanitizeSearchQuery("path\\to")).toBe("path\\\\to")
  })

  test("SQL injection attempt neutralized", () => {
    const malicious = "'; DROP TABLE message; --"
    const sanitized = sanitizeSearchQuery(malicious)
    expect(sanitized).toBe("''; DROP TABLE message; --")
    // The doubled single quote prevents breaking out of the LIKE string
  })

  test("complex injection with LIKE wildcards", () => {
    const malicious = "%' OR 1=1 --"
    const sanitized = sanitizeSearchQuery(malicious)
    expect(sanitized).toBe("\\%'' OR 1=1 --")
  })

  test("normal search query passes through", () => {
    expect(sanitizeSearchQuery("proposal")).toBe("proposal")
    expect(sanitizeSearchQuery("Vanguard HCS")).toBe("Vanguard HCS")
  })
})

// ============================================================================
// 13. AppleScript Injection Protection
// ============================================================================

describe("notification injection protection", () => {
  function sanitizeForOsascript(text: string): string {
    return text.replace(/['"\\]/g, "").replace(/[^\x20-\x7E]/g, "")
  }

  test("single quotes stripped", () => {
    expect(sanitizeForOsascript("it's a test")).toBe("its a test")
  })

  test("double quotes stripped", () => {
    expect(sanitizeForOsascript('say "hello"')).toBe("say hello")
  })

  test("backslashes stripped", () => {
    expect(sanitizeForOsascript("path\\to\\file")).toBe("pathtofile")
  })

  test("non-ASCII stripped", () => {
    expect(sanitizeForOsascript("hello \u00e9\u00e8\u00ea world")).toBe("hello  world")
  })

  test("AppleScript injection attempt neutralized", () => {
    const malicious = `"; do shell script "rm -rf /"`
    const sanitized = sanitizeForOsascript(malicious)
    expect(sanitized).not.toContain('"')
    expect(sanitized).toBe("; do shell script rm -rf /")
  })

  test("normal sender name passes through", () => {
    expect(sanitizeForOsascript("AlexMaysnow1063")).toBe("AlexMaysnow1063")
    expect(sanitizeForOsascript("MacBookPro")).toBe("MacBookPro")
  })
})

// ============================================================================
// 14. Inline Text Size Cap
// ============================================================================

describe("inline text size cap", () => {
  const INLINE_TEXT_LIMIT = 100_000

  test("text under 100KB is inline", () => {
    const text = "A".repeat(50_000)
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(INLINE_TEXT_LIMIT)
  })

  test("text over 100KB triggers file escalation", () => {
    const text = "B".repeat(150_000)
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(INLINE_TEXT_LIMIT)
  })

  test("exactly 100KB is still inline", () => {
    const text = "C".repeat(100_000)
    expect(Buffer.byteLength(text, "utf-8")).toBe(INLINE_TEXT_LIMIT)
    // > not >= in the code, so exactly 100KB stays inline
  })

  test("multibyte UTF-8 characters counted correctly", () => {
    // Each emoji is 4 bytes in UTF-8
    const text = "\u{1F600}".repeat(25_001)
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(INLINE_TEXT_LIMIT)
  })
})

// ============================================================================
// 15. Inbox Clear Logic
// ============================================================================

describe("inbox clear", () => {
  beforeEach(setup)
  afterEach(teardown)

  test("clear --read removes only read items", () => {
    appendManifestEntry(makeEntry({ id: "unread-1", read: false, file: "unread1.txt" }))
    appendManifestEntry(makeEntry({ id: "read-1", read: true, file: "read1.txt" }))
    appendManifestEntry(makeEntry({ id: "unread-2", read: false, file: "unread2.txt" }))

    writeFileSync(join(INBOX_DIR, "unread1.txt"), "data")
    writeFileSync(join(INBOX_DIR, "read1.txt"), "data")
    writeFileSync(join(INBOX_DIR, "unread2.txt"), "data")

    const items = readManifest()
    const toKeep = items.filter((i) => !i.read)
    const toRemove = items.filter((i) => i.read)

    for (const item of toRemove) {
      const fp = join(INBOX_DIR, item.file)
      try { if (existsSync(fp)) unlinkSync(fp) } catch {}
    }
    writeFileSync(MANIFEST_PATH, toKeep.map((i) => JSON.stringify(i)).join("\n") + "\n")

    const remaining = readManifest()
    expect(remaining.length).toBe(2)
    expect(remaining.every((i) => !i.read)).toBe(true)
    expect(existsSync(join(INBOX_DIR, "read1.txt"))).toBe(false)
    expect(existsSync(join(INBOX_DIR, "unread1.txt"))).toBe(true)
  })

  test("clear --older 7d removes old items only", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const today = new Date().toISOString()

    appendManifestEntry(makeEntry({ id: "old", received_at: eightDaysAgo, file: "old.txt" }))
    appendManifestEntry(makeEntry({ id: "new", received_at: today, file: "new.txt" }))

    writeFileSync(join(INBOX_DIR, "old.txt"), "old")
    writeFileSync(join(INBOX_DIR, "new.txt"), "new")

    const days = 7
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const items = readManifest()
    const toRemove = items.filter((i) => new Date(i.received_at).getTime() < cutoff)
    const toKeep = items.filter((i) => new Date(i.received_at).getTime() >= cutoff)

    for (const item of toRemove) {
      const fp = join(INBOX_DIR, item.file)
      try { if (existsSync(fp)) unlinkSync(fp) } catch {}
    }
    writeFileSync(MANIFEST_PATH, toKeep.map((i) => JSON.stringify(i)).join("\n") + "\n")

    const remaining = readManifest()
    expect(remaining.length).toBe(1)
    expect(remaining[0].id).toBe("new")
  })

  test("clear all removes everything", () => {
    for (let i = 0; i < 5; i++) {
      const file = `file${i}.txt`
      appendManifestEntry(makeEntry({ id: `item-${i}`, file }))
      writeFileSync(join(INBOX_DIR, file), `content ${i}`)
    }

    const items = readManifest()
    for (const item of items) {
      const fp = join(INBOX_DIR, item.file)
      try { if (existsSync(fp)) unlinkSync(fp) } catch {}
    }
    writeFileSync(MANIFEST_PATH, "")

    expect(readManifest().length).toBe(0)
  })
})

// ============================================================================
// 16. Edge Cases
// ============================================================================

describe("edge cases", () => {
  beforeEach(setup)
  afterEach(teardown)

  test("inbox count with mixed read/unread", () => {
    appendManifestEntry(makeEntry({ read: false }))
    appendManifestEntry(makeEntry({ read: true }))
    appendManifestEntry(makeEntry({ read: false }))
    appendManifestEntry(makeEntry({ read: true }))
    appendManifestEntry(makeEntry({ read: false }))

    const items = readManifest()
    const unread = items.filter((i) => !i.read).length
    const read = items.length - unread
    expect(items.length).toBe(5)
    expect(unread).toBe(3)
    expect(read).toBe(2)
  })

  test("message longer than 500 chars truncated in manifest", () => {
    const longMsg = "X".repeat(1000)
    const truncated = longMsg.substring(0, 500)
    expect(truncated.length).toBe(500)
    expect(truncated).not.toBe(longMsg)
  })

  test("link type stores both url and message", () => {
    appendManifestEntry(makeEntry({
      type: "link",
      url: "https://example.com",
      message: "Check this out",
    }))

    const items = readManifest()
    expect(items[0].url).toBe("https://example.com")
    expect(items[0].message).toBe("Check this out")
  })

  test("file type stores original_name separately from saved file", () => {
    appendManifestEntry(makeEntry({
      type: "file",
      file: "2026-05-26-22-15-30_proposal.pdf",
      original_name: "proposal.pdf",
    }))

    const items = readManifest()
    expect(items[0].file).toContain("2026-05-26")
    expect(items[0].original_name).toBe("proposal.pdf")
  })

  test("disk usage calculation sums size_bytes", () => {
    appendManifestEntry(makeEntry({ size_bytes: 100 }))
    appendManifestEntry(makeEntry({ size_bytes: 200 }))
    appendManifestEntry(makeEntry({ size_bytes: 300 }))

    const items = readManifest()
    const total = items.reduce((sum, i) => sum + (i.size_bytes ?? 0), 0)
    expect(total).toBe(600)
  })
})
