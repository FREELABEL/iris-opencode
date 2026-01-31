#!/usr/bin/env node

// Demo script to showcase IRIS Admin Statistics
// This simulates the admin stats functionality for demonstration

const mockStats = {
  totalSessions: 1247,
  totalMessages: 5843,
  totalCost: 147.23,
  totalTokens: {
    input: 2456789,
    output: 1234567,
    reasoning: 456789,
    cache: {
      read: 234567,
      write: 123456
    }
  },
  toolUsage: {
    'bash': 2341,
    'read': 1892,
    'edit': 1456,
    'grep': 987,
    'write': 765,
    'webfetch': 543,
    'todoread': 432,
    'todowrite': 387,
    'question': 298,
    'glob': 234
  },
  modelUsage: {
    'openai/gpt-4o-mini': {
      messages: 3456,
      tokens: { input: 1234567, output: 567890 },
      cost: 89.45
    },
    'anthropic/claude-3-5-haiku': {
      messages: 1234,
      tokens: { input: 567890, output: 234567 },
      cost: 34.78
    },
    'openai/gpt-4o': {
      messages: 456,
      tokens: { input: 234567, output: 123456 },
      cost: 23.00
    }
  },
  dateRange: {
    earliest: Date.now() - (30 * 24 * 60 * 60 * 1000), // 30 days ago
    latest: Date.now()
  },
  days: 30,
  costPerDay: 4.91,
  tokensPerSession: 3456,
  medianTokensPerSession: 3123
};

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

function displayAdminStats(stats, period = "monthly") {
  const width = 56

  function renderRow(label, value) {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Admin Dashboard Header
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    IRIS ADMIN STATS                    │")
  console.log(`│                    ${period.toUpperCase()} VIEW                     │`)
  console.log("├────────────────────────────────────────────────────────┤")

  // Key Admin Metrics
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                   KEY PERFORMANCE METRICS               │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Total Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Total Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Active Days", stats.days.toString()))
  console.log(renderRow("Avg Sessions/Day", Math.round(stats.totalSessions / stats.days).toString()))
  console.log(renderRow("Avg Messages/Session", Math.round(stats.totalMessages / stats.totalSessions).toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost Analysis
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                      COST ANALYSIS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = stats.totalCost
  const costPerDay = stats.costPerDay
  const costPerSession = stats.totalSessions > 0 ? cost / stats.totalSessions : 0
  
  console.log(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Session", `$${costPerSession.toFixed(4)}`))
  console.log(renderRow("Est Monthly Cost", `$${(costPerDay * 30).toFixed(2)}`))
  console.log(renderRow("Est Annual Cost", `$${(costPerDay * 365).toFixed(2)}`))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Token Efficiency Metrics
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    TOKEN EFFICIENCY                     │")
  console.log("├────────────────────────────────────────────────────────┤")
  const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning
  const tokensPerSession = totalTokens / stats.totalSessions
  const medianTokensPerSession = stats.medianTokensPerSession
  const cacheHitRate = totalTokens > 0 ? (stats.totalTokens.cache.read / totalTokens) * 100 : 0
  
  console.log(renderRow("Total Input Tokens", formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Total Output Tokens", formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Total Reasoning Tokens", formatNumber(stats.totalTokens.reasoning)))
  console.log(renderRow("Cache Reads", formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Writes", formatNumber(stats.totalTokens.cache.write)))
  console.log(renderRow("Cache Hit Rate", `${cacheHitRate.toFixed(1)}%`))
  console.log(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  console.log(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Top Costly Models
  const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.cost - a.cost)

  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                 TOP COSTLY MODELS                       │")
  console.log("├────────────────────────────────────────────────────────┤")

  for (const [model, usage] of sortedModels) {
    const avgTokensPerMessage = usage.messages > 0 
      ? (usage.tokens.input + usage.tokens.output) / usage.messages 
      : 0
    
    console.log(`│ ${model.padEnd(54)} │`)
    console.log(renderRow("  Total Cost", `$${usage.cost.toFixed(4)}`))
    console.log(renderRow("  Messages", usage.messages.toLocaleString()))
    console.log(renderRow("  Avg Tokens/Msg", formatNumber(Math.round(avgTokensPerMessage))))
    console.log(renderRow("  Cost per Message", `$${(usage.cost / usage.messages).toFixed(6)}`))
    console.log("├────────────────────────────────────────────────────────┤")
  }
  process.stdout.write("\x1B[1A")
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Tool Usage Analysis
  const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
  const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                   TOOL USAGE ANALYSIS                   │")
  console.log("├────────────────────────────────────────────────────────┤")

  const maxCount = Math.max(...sortedTools.map(([, count]) => count))

  for (const [tool, count] of sortedTools) {
    const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
    const bar = "█".repeat(barLength)
    const percentage = ((count / totalToolUsage) * 100).toFixed(1)

    const maxToolLength = 18
    const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
    const toolName = truncatedTool.padEnd(maxToolLength)

    const usagePerSession = stats.totalSessions > 0 ? (count / stats.totalSessions).toFixed(2) : "0.00"

    const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%) [${usagePerSession}/session]`
    const padding = Math.max(0, width - content.length - 1)
    console.log(`│${content}${" ".repeat(padding)} │`)
  }
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Admin Summary
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    ADMIN SUMMARY                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  
  const efficiencyScore = 78
  const utilizationRate = "65%"
  const costEfficiency = "Good"
  
  console.log(renderRow("Efficiency Score", `${efficiencyScore}/100`))
  console.log(renderRow("Utilization Rate", utilizationRate))
  console.log(renderRow("Cost Efficiency", costEfficiency))
  console.log(renderRow("Health Status", "🟡 Good"))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // AI Insights
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                      AI INSIGHTS                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  const insights = [
    "Cost-efficient usage pattern observed",
    "Optimal token efficiency maintained",
    "High dependency on bash tool",
    "Good model diversity for resilience",
    "Excellent cache utilization"
  ]
  
  insights.forEach((insight, index) => {
    console.log(`│ ${index + 1}. ${insight.padEnd(52)} │`)
  })
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()
}

// Usage instructions
console.log("🚀 IRIS CLI Admin Statistics Demo");
console.log("\nUsage Examples:");
console.log("  iris stats --admin                    # Show admin stats");
console.log("  iris stats --admin --period=daily     # Daily view");
console.log("  iris stats --admin --period=weekly    # Weekly view");
console.log("  iris stats --admin --period=monthly   # Monthly view");
console.log("  iris stats --admin --models=5         # Top 5 models");
console.log("  iris stats --admin --tools=10         # Top 10 tools");
console.log("\n" + "=".repeat(60) + "\n");

displayAdminStats(mockStats, "monthly");

console.log("\n✨ Enhanced admin statistics functionality is now available!");
console.log("Run 'iris stats --help' for more options.");