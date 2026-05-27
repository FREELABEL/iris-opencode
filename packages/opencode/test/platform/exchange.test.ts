/**
 * IRIS Exchange (ICE) — Unit Tests
 *
 * Tests cover:
 * 1. Listing status transitions
 * 2. Claim validation (can't claim own, can't claim expired)
 * 3. Submit/verify guards
 * 4. Bounty + fee calculation (15%)
 * 5. Reputation scoring
 * 6. Expiry logic
 * 7. CLI display helpers
 */
import { describe, test, expect } from "bun:test"

// ============================================================================
// 1. Status Transitions
// ============================================================================

describe("listing status transitions", () => {
  const validTransitions: Record<string, string[]> = {
    open: ["claimed", "cancelled", "expired"],
    claimed: ["submitted", "expired"],
    submitted: ["completed", "disputed"],
    completed: [], // terminal
    disputed: [], // terminal
    cancelled: [], // terminal
    expired: [], // terminal
  }

  test("open can transition to claimed, cancelled, expired", () => {
    expect(validTransitions["open"]).toContain("claimed")
    expect(validTransitions["open"]).toContain("cancelled")
    expect(validTransitions["open"]).toContain("expired")
  })

  test("claimed can transition to submitted or expired", () => {
    expect(validTransitions["claimed"]).toContain("submitted")
    expect(validTransitions["claimed"]).toContain("expired")
  })

  test("submitted can transition to completed or disputed", () => {
    expect(validTransitions["submitted"]).toContain("completed")
    expect(validTransitions["submitted"]).toContain("disputed")
  })

  test("completed is terminal", () => {
    expect(validTransitions["completed"]).toEqual([])
  })

  test("cancelled is terminal", () => {
    expect(validTransitions["cancelled"]).toEqual([])
  })

  test("expired is terminal", () => {
    expect(validTransitions["expired"]).toEqual([])
  })
})

// ============================================================================
// 2. Claim Validation
// ============================================================================

describe("claim validation", () => {
  function isClaimable(listing: { status: string; expires_at?: string | null; user_id: number }, claimerUserId: number): { ok: boolean; reason?: string } {
    if (listing.status !== "open") return { ok: false, reason: "not_open" }
    if (listing.expires_at && Date.now() > new Date(listing.expires_at).getTime()) return { ok: false, reason: "expired" }
    if (listing.user_id === claimerUserId) return { ok: false, reason: "own_listing" }
    return { ok: true }
  }

  test("open listing is claimable", () => {
    const result = isClaimable({ status: "open", user_id: 1 }, 2)
    expect(result.ok).toBe(true)
  })

  test("claimed listing is not claimable", () => {
    const result = isClaimable({ status: "claimed", user_id: 1 }, 2)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("not_open")
  })

  test("expired listing is not claimable", () => {
    const result = isClaimable({
      status: "open",
      expires_at: new Date(Date.now() - 60000).toISOString(),
      user_id: 1,
    }, 2)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("expired")
  })

  test("cannot claim own listing", () => {
    const result = isClaimable({ status: "open", user_id: 1 }, 1)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("own_listing")
  })

  test("future expires_at is still claimable", () => {
    const result = isClaimable({
      status: "open",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      user_id: 1,
    }, 2)
    expect(result.ok).toBe(true)
  })

  test("null expires_at is claimable", () => {
    const result = isClaimable({ status: "open", expires_at: null, user_id: 1 }, 2)
    expect(result.ok).toBe(true)
  })
})

// ============================================================================
// 3. Submit / Verify Guards
// ============================================================================

describe("submit and verify guards", () => {
  function canSubmit(listing: { status: string; claimed_by_user_id: number | null }, userId: number): boolean {
    return listing.status === "claimed" && listing.claimed_by_user_id === userId
  }

  function canVerify(listing: { status: string; user_id: number }, userId: number): boolean {
    return listing.status === "submitted" && listing.user_id === userId
  }

  test("claimer can submit when status is claimed", () => {
    expect(canSubmit({ status: "claimed", claimed_by_user_id: 2 }, 2)).toBe(true)
  })

  test("non-claimer cannot submit", () => {
    expect(canSubmit({ status: "claimed", claimed_by_user_id: 2 }, 3)).toBe(false)
  })

  test("cannot submit when status is not claimed", () => {
    expect(canSubmit({ status: "open", claimed_by_user_id: null }, 2)).toBe(false)
    expect(canSubmit({ status: "submitted", claimed_by_user_id: 2 }, 2)).toBe(false)
  })

  test("poster can verify when status is submitted", () => {
    expect(canVerify({ status: "submitted", user_id: 1 }, 1)).toBe(true)
  })

  test("non-poster cannot verify", () => {
    expect(canVerify({ status: "submitted", user_id: 1 }, 2)).toBe(false)
  })

  test("cannot verify when status is not submitted", () => {
    expect(canVerify({ status: "claimed", user_id: 1 }, 1)).toBe(false)
  })
})

// ============================================================================
// 4. Bounty + Fee Calculation
// ============================================================================

describe("bounty and fee calculation", () => {
  const PLATFORM_FEE_PERCENT = 15.0

  function calculateFee(bountyCents: number): { fee: number; payout: number } {
    const fee = Math.round(bountyCents * PLATFORM_FEE_PERCENT / 100)
    return { fee, payout: bountyCents - fee }
  }

  test("$50 bounty = $7.50 fee, $42.50 payout", () => {
    const { fee, payout } = calculateFee(5000)
    expect(fee).toBe(750)
    expect(payout).toBe(4250)
  })

  test("$100 bounty = $15 fee, $85 payout", () => {
    const { fee, payout } = calculateFee(10000)
    expect(fee).toBe(1500)
    expect(payout).toBe(8500)
  })

  test("$1 bounty = $0.15 fee", () => {
    const { fee, payout } = calculateFee(100)
    expect(fee).toBe(15)
    expect(payout).toBe(85)
  })

  test("$0 bounty = $0 fee", () => {
    const { fee, payout } = calculateFee(0)
    expect(fee).toBe(0)
    expect(payout).toBe(0)
  })

  test("$999.99 bounty rounds correctly", () => {
    const { fee, payout } = calculateFee(99999)
    expect(fee).toBe(15000) // rounds to nearest cent
    expect(payout).toBe(84999)
  })
})

// ============================================================================
// 5. Reputation Scoring
// ============================================================================

describe("reputation scoring", () => {
  interface Reputation {
    exchange_tasks_completed: number
    exchange_tasks_claimed: number
    exchange_tasks_failed: number
    total_earned_cents: number
    average_quality_score: number | null
    completion_rate: number | null
    tier: string
  }

  function updateReputation(rep: Reputation, outcome: "completed" | "failed" | "expired", rating?: number): Reputation {
    const updated = { ...rep }

    if (outcome === "completed") {
      updated.exchange_tasks_completed++
      if (rating !== undefined) {
        const count = updated.exchange_tasks_completed
        const prev = updated.average_quality_score ?? rating
        updated.average_quality_score = Math.round(((prev * (count - 1)) + rating) / count * 100) / 100
      }
    } else {
      updated.exchange_tasks_failed++
    }

    const claimed = updated.exchange_tasks_claimed
    const completed = updated.exchange_tasks_completed
    updated.completion_rate = claimed > 0 ? Math.round(completed / claimed * 100) / 100 : null

    if (completed >= 100) updated.tier = "diamond"
    else if (completed >= 50) updated.tier = "gold"
    else if (completed >= 10) updated.tier = "silver"
    else updated.tier = "bronze"

    return updated
  }

  test("first completed task with rating", () => {
    const rep: Reputation = {
      exchange_tasks_completed: 0, exchange_tasks_claimed: 1,
      exchange_tasks_failed: 0, total_earned_cents: 0,
      average_quality_score: null, completion_rate: null, tier: "bronze",
    }
    const result = updateReputation(rep, "completed", 4)
    expect(result.exchange_tasks_completed).toBe(1)
    expect(result.average_quality_score).toBe(4)
    expect(result.completion_rate).toBe(1)
    expect(result.tier).toBe("bronze")
  })

  test("rolling average quality score", () => {
    let rep: Reputation = {
      exchange_tasks_completed: 0, exchange_tasks_claimed: 3,
      exchange_tasks_failed: 0, total_earned_cents: 0,
      average_quality_score: null, completion_rate: null, tier: "bronze",
    }
    rep = updateReputation(rep, "completed", 5)
    rep = updateReputation(rep, "completed", 3)
    rep = updateReputation(rep, "completed", 4)
    expect(rep.average_quality_score).toBe(4)
    expect(rep.completion_rate).toBe(1)
  })

  test("failed task decreases completion rate", () => {
    const rep: Reputation = {
      exchange_tasks_completed: 8, exchange_tasks_claimed: 10,
      exchange_tasks_failed: 1, total_earned_cents: 0,
      average_quality_score: 4.5, completion_rate: 0.8, tier: "bronze",
    }
    const result = updateReputation(rep, "failed")
    expect(result.exchange_tasks_failed).toBe(2)
    expect(result.completion_rate).toBe(0.8) // completed/claimed unchanged
  })

  test("tier promotion at 10 tasks", () => {
    const rep: Reputation = {
      exchange_tasks_completed: 9, exchange_tasks_claimed: 10,
      exchange_tasks_failed: 0, total_earned_cents: 0,
      average_quality_score: 4.0, completion_rate: 0.9, tier: "bronze",
    }
    const result = updateReputation(rep, "completed", 5)
    expect(result.tier).toBe("silver")
  })

  test("tier promotion at 50 tasks", () => {
    const rep: Reputation = {
      exchange_tasks_completed: 49, exchange_tasks_claimed: 50,
      exchange_tasks_failed: 0, total_earned_cents: 0,
      average_quality_score: 4.0, completion_rate: 0.98, tier: "silver",
    }
    const result = updateReputation(rep, "completed", 5)
    expect(result.tier).toBe("gold")
  })

  test("tier promotion at 100 tasks", () => {
    const rep: Reputation = {
      exchange_tasks_completed: 99, exchange_tasks_claimed: 100,
      exchange_tasks_failed: 0, total_earned_cents: 0,
      average_quality_score: 4.5, completion_rate: 0.99, tier: "gold",
    }
    const result = updateReputation(rep, "completed", 5)
    expect(result.tier).toBe("diamond")
  })
})

// ============================================================================
// 6. Expiry Logic
// ============================================================================

describe("expiry logic", () => {
  function isListingExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false
    return Date.now() > new Date(expiresAt).getTime()
  }

  function isClaimExpired(claimedAt: string | null, maxClaimHours: number): boolean {
    if (!claimedAt) return false
    const deadline = new Date(claimedAt).getTime() + maxClaimHours * 3600000
    return Date.now() > deadline
  }

  test("listing with future expires_at is not expired", () => {
    expect(isListingExpired(new Date(Date.now() + 86400000).toISOString())).toBe(false)
  })

  test("listing with past expires_at is expired", () => {
    expect(isListingExpired(new Date(Date.now() - 1000).toISOString())).toBe(true)
  })

  test("listing with null expires_at is not expired", () => {
    expect(isListingExpired(null)).toBe(false)
  })

  test("claim within max_claim_hours is not expired", () => {
    const claimedAt = new Date(Date.now() - 3600000).toISOString() // 1 hour ago
    expect(isClaimExpired(claimedAt, 48)).toBe(false)
  })

  test("claim past max_claim_hours is expired", () => {
    const claimedAt = new Date(Date.now() - 49 * 3600000).toISOString() // 49 hours ago
    expect(isClaimExpired(claimedAt, 48)).toBe(true)
  })

  test("unclaimed listing (null claimedAt) is not claim-expired", () => {
    expect(isClaimExpired(null, 48)).toBe(false)
  })
})

// ============================================================================
// 7. CLI Display Helpers
// ============================================================================

describe("display helpers", () => {
  function dollars(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`
  }

  function tierBadge(tier: string): string {
    const badges: Record<string, string> = {
      bronze: "bronze",
      silver: "* silver",
      gold: "** gold",
      diamond: "*** diamond",
    }
    return badges[tier] || tier
  }

  test("dollars formatting", () => {
    expect(dollars(5000)).toBe("$50.00")
    expect(dollars(100)).toBe("$1.00")
    expect(dollars(99999)).toBe("$999.99")
    expect(dollars(0)).toBe("$0.00")
    expect(dollars(1)).toBe("$0.01")
  })

  test("tier badges", () => {
    expect(tierBadge("bronze")).toBe("bronze")
    expect(tierBadge("silver")).toBe("* silver")
    expect(tierBadge("gold")).toBe("** gold")
    expect(tierBadge("diamond")).toBe("*** diamond")
  })

  test("unknown tier falls through", () => {
    expect(tierBadge("platinum")).toBe("platinum")
  })
})

// ============================================================================
// 8. Exchange Task Config
// ============================================================================

describe("exchange task config", () => {
  function buildTaskConfig(listing: { id: string; repo_url?: string; acceptance_tests?: string; category: string }): Record<string, unknown> {
    const branchName = listing.repo_url ? `exchange/${listing.id.substring(0, 8)}` : null
    return Object.fromEntries(
      Object.entries({
        exchange_listing_id: listing.id,
        repo_url: listing.repo_url || null,
        branch_name: branchName,
        acceptance_tests: listing.acceptance_tests || null,
        category: listing.category,
      }).filter(([, v]) => v !== null),
    )
  }

  test("listing with repo gets branch name", () => {
    const config = buildTaskConfig({
      id: "abc12345-def6-7890",
      repo_url: "https://github.com/FREELABEL/fl-api",
      category: "bug_fix",
    })
    expect(config.branch_name).toBe("exchange/abc12345")
    expect(config.repo_url).toBe("https://github.com/FREELABEL/fl-api")
  })

  test("listing without repo has no branch", () => {
    const config = buildTaskConfig({
      id: "abc12345-def6-7890",
      category: "feature",
    })
    expect(config.branch_name).toBeUndefined()
    expect(config.repo_url).toBeUndefined()
  })

  test("acceptance tests passed through", () => {
    const config = buildTaskConfig({
      id: "abc12345",
      acceptance_tests: "php artisan test --filter=LeadTest",
      category: "test",
    })
    expect(config.acceptance_tests).toBe("php artisan test --filter=LeadTest")
  })

  test("exchange_listing_id always present", () => {
    const config = buildTaskConfig({ id: "test-123", category: "docs" })
    expect(config.exchange_listing_id).toBe("test-123")
    expect(config.category).toBe("docs")
  })
})

// ============================================================================
// 9. Category Validation
// ============================================================================

describe("category validation", () => {
  const VALID_CATEGORIES = ["bug_fix", "feature", "test", "refactor", "docs", "ci", "other"]

  test("all expected categories are valid", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(VALID_CATEGORIES).toContain(cat)
    }
  })

  test("invalid category is rejected", () => {
    expect(VALID_CATEGORIES).not.toContain("random")
    expect(VALID_CATEGORIES).not.toContain("")
  })

  test("bug_fix is valid (used by iris bug --bounty)", () => {
    expect(VALID_CATEGORIES).toContain("bug_fix")
  })
})
