import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { bootstrap } from "../bootstrap"
import { Storage } from "../../storage/storage"
import { Project } from "../../project/project"
import { Instance } from "../../project/instance"

interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const StatsCommand = cmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) => {
    return yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
  .option("project", {
    describe: "filter by project (default: all projects, empty string: current project)",
    type: "string",
  })
  .option("period", {
    describe: "time period for analysis (daily, weekly, monthly, all)",
    type: "string",
    default: "all"
  })
  .option("admin", {
    describe: "show admin-focused statistics",
    type: "boolean",
    default: false
  })
  },
  handler: async (args) => {
    try {
      await bootstrap(process.cwd(), async () => {
        const stats = await aggregateSessionStats(args.days, args.project)

        let modelLimit: number | undefined
        if (args.models === true) {
          modelLimit = Infinity
        } else if (typeof args.models === "number") {
          modelLimit = args.models
        }

        if (args.admin) {
          displayAdminStats(stats, args.period, args.tools, modelLimit)
        } else {
          displayStats(stats, args.tools, modelLimit)
        }
      })
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error("Error: Corrupted session data detected. Some session files contain invalid JSON.")
        console.error("Run with --days 0 to only show today's stats, or delete corrupted files from ~/.local/share/opencode/storage/")
        process.exitCode = 1
      } else {
        throw err
      }
    }
  },
})

async function getCurrentProject(): Promise<Project.Info> {
  return Instance.project
}

async function getAllSessions(): Promise<Session.Info[]> {
  const sessions: Session.Info[] = []

  const projectKeys = await Storage.list(["project"])
  const projects = await Promise.all(projectKeys.map((key) => Storage.read<Project.Info>(key).catch(() => null)))

  for (const project of projects) {
    if (!project) continue

    const sessionKeys = await Storage.list(["session", project.id])
    const projectSessions = await Promise.all(sessionKeys.map((key) => Storage.read<Session.Info>(key).catch(() => null)))

    for (const session of projectSessions) {
      if (session) {
        sessions.push(session)
      }
    }
  }

  return sessions
}

export async function aggregateSessionStats(days?: number, projectFilter?: string): Promise<SessionStats> {
  const sessions = await getAllSessions()
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  let filteredSessions = cutoffTime > 0 ? sessions.filter((session) => session.time.updated >= cutoffTime) : sessions

  if (projectFilter !== undefined) {
    if (projectFilter === "") {
      const currentProject = await getCurrentProject()
      filteredSessions = filteredSessions.filter((session) => session.projectID === currentProject.id)
    } else {
      filteredSessions = filteredSessions.filter((session) => session.projectID === projectFilter)
    }
  }

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0

  const sessionTotalTokens: number[] = []

  const BATCH_SIZE = 20
  for (let i = 0; i < filteredSessions.length; i += BATCH_SIZE) {
    const batch = filteredSessions.slice(i, i + BATCH_SIZE)

    const batchPromises = batch.map(async (session) => {
      const messages = await Session.messages({ sessionID: session.id }).catch(() => [] as any[])

      let sessionCost = 0
      let sessionTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      let sessionToolUsage: Record<string, number> = {}
      let sessionModelUsage: Record<
        string,
        {
          messages: number
          tokens: {
            input: number
            output: number
          }
          cost: number
        }
      > = {}

      for (const message of messages) {
        if (message.info.role === "assistant") {
          sessionCost += message.info.cost || 0

          const modelKey = `${message.info.providerID}/${message.info.modelID}`
          if (!sessionModelUsage[modelKey]) {
            sessionModelUsage[modelKey] = {
              messages: 0,
              tokens: { input: 0, output: 0 },
              cost: 0,
            }
          }
          sessionModelUsage[modelKey].messages++
          sessionModelUsage[modelKey].cost += message.info.cost || 0

          if (message.info.tokens) {
            sessionTokens.input += message.info.tokens.input || 0
            sessionTokens.output += message.info.tokens.output || 0
            sessionTokens.reasoning += message.info.tokens.reasoning || 0
            sessionTokens.cache.read += message.info.tokens.cache?.read || 0
            sessionTokens.cache.write += message.info.tokens.cache?.write || 0

            sessionModelUsage[modelKey].tokens.input += message.info.tokens.input || 0
            sessionModelUsage[modelKey].tokens.output +=
              (message.info.tokens.output || 0) + (message.info.tokens.reasoning || 0)
          }
        }

        for (const part of message.parts) {
          if (part.type === "tool" && part.tool) {
            sessionToolUsage[part.tool] = (sessionToolUsage[part.tool] || 0) + 1
          }
        }
      }

      return {
        messageCount: messages.length,
        sessionCost,
        sessionTokens,
        sessionTotalTokens: sessionTokens.input + sessionTokens.output + sessionTokens.reasoning,
        sessionToolUsage,
        sessionModelUsage,
        earliestTime: cutoffTime > 0 ? session.time.updated : session.time.created,
        latestTime: session.time.updated,
      }
    })

    const batchResults = await Promise.all(batchPromises)

    for (const result of batchResults) {
      earliestTime = Math.min(earliestTime, result.earliestTime)
      latestTime = Math.max(latestTime, result.latestTime)
      sessionTotalTokens.push(result.sessionTotalTokens)

      stats.totalMessages += result.messageCount
      stats.totalCost += result.sessionCost
      stats.totalTokens.input += result.sessionTokens.input
      stats.totalTokens.output += result.sessionTokens.output
      stats.totalTokens.reasoning += result.sessionTokens.reasoning
      stats.totalTokens.cache.read += result.sessionTokens.cache.read
      stats.totalTokens.cache.write += result.sessionTokens.cache.write

      for (const [tool, count] of Object.entries(result.sessionToolUsage)) {
        stats.toolUsage[tool] = (stats.toolUsage[tool] || 0) + count
      }

      for (const [model, usage] of Object.entries(result.sessionModelUsage)) {
        if (!stats.modelUsage[model]) {
          stats.modelUsage[model] = {
            messages: 0,
            tokens: { input: 0, output: 0 },
            cost: 0,
          }
        }
        stats.modelUsage[model].messages += usage.messages
        stats.modelUsage[model].tokens.input += usage.tokens.input
        stats.modelUsage[model].tokens.output += usage.tokens.output
        stats.modelUsage[model].cost += usage.cost
      }
    }
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
}

export function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                       OVERVIEW                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Days", stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    COST & TOKENS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow("Input", formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Output", formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      MODEL USAGE                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  Messages", usage.messages.toLocaleString()))
      console.log(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
      console.log(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      TOOL USAGE                        │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

export function displayAdminStats(stats: SessionStats, period: string = "all", toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
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
  console.log(renderRow("Avg Sessions/Day", Math.round(stats.totalSessions / Math.max(1, stats.days)).toString()))
  console.log(renderRow("Avg Messages/Session", Math.round(stats.totalMessages / Math.max(1, stats.totalSessions)).toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost Analysis
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                      COST ANALYSIS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
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
  const tokensPerSession = isNaN(stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning / stats.totalSessions) ? 0 : totalTokens / Math.max(1, stats.totalSessions)
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
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

  // Period-based Analysis
  if (period !== "all") {
    console.log("┌────────────────────────────────────────────────────────┐")
    console.log(`│                  ${period.toUpperCase()} PERFORMANCE                 │`)
    console.log("├────────────────────────────────────────────────────────┤")
    
    const dailyAvg = stats.totalSessions / Math.max(1, stats.days)
    const weeklyTotal = dailyAvg * 7
    const monthlyTotal = dailyAvg * 30
    
    console.log(renderRow("Daily Average Sessions", Math.round(dailyAvg).toString()))
    console.log(renderRow("Weekly Projected Sessions", Math.round(weeklyTotal).toString()))
    console.log(renderRow("Monthly Projected Sessions", Math.round(monthlyTotal).toString()))
    console.log(renderRow("Daily Avg Cost", `$${costPerDay.toFixed(2)}`))
    console.log(renderRow("Weekly Projected Cost", `$${(costPerDay * 7).toFixed(2)}`))
    console.log(renderRow("Monthly Projected Cost", `$${(costPerDay * 30).toFixed(2)}`))
    console.log("└────────────────────────────────────────────────────────┘")
    console.log()
  }

  // Model Performance (top performers)
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.cost - a.cost)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                 TOP COSTLY MODELS                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
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
  }
  console.log()

  // Tool Usage (admin view with insights)
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                   TOOL USAGE ANALYSIS                   │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
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
  }
  console.log()

  // Admin Summary Box
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    ADMIN SUMMARY                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  
  const efficiencyScore = calculateEfficiencyScore(stats)
  const utilizationRate = calculateUtilizationRate(stats)
  const costEfficiency = calculateCostEfficiency(stats)
  
  console.log(renderRow("Efficiency Score", `${efficiencyScore}/100`))
  console.log(renderRow("Utilization Rate", `${utilizationRate}%`))
  console.log(renderRow("Cost Efficiency", costEfficiency))
  console.log(renderRow("Health Status", getHealthStatus(stats)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // AI-powered Insights
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                      AI INSIGHTS                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  const insights = generateInsights(stats)
  insights.forEach((insight, index) => {
    console.log(`│ ${index + 1}. ${insight.padEnd(52)} │`)
  })
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()
}

function calculateEfficiencyScore(stats: SessionStats): number {
  let score = 50 // Base score
  
  // Token efficiency (30% of score)
  const avgTokens = stats.totalSessions > 0 
    ? (stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning) / stats.totalSessions 
    : 0
  if (avgTokens < 1000) score += 15
  else if (avgTokens < 5000) score += 10
  else if (avgTokens < 10000) score += 5
  
  // Cost efficiency (20% of score)
  if (stats.costPerDay < 1) score += 10
  else if (stats.costPerDay < 5) score += 5
  else if (stats.costPerDay < 10) score += 2
  
  // Cache efficiency (20% of score)
  const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning
  const cacheRate = totalTokens > 0 ? (stats.totalTokens.cache.read / totalTokens) * 100 : 0
  if (cacheRate > 20) score += 10
  else if (cacheRate > 10) score += 5
  else if (cacheRate > 5) score += 2
  
  // Session consistency (20% of score)
  if (stats.medianTokensPerSession > 0) {
    const variance = Math.abs(stats.tokensPerSession - stats.medianTokensPerSession) / stats.medianTokensPerSession
    if (variance < 0.2) score += 10
    else if (variance < 0.5) score += 5
    else if (variance < 1.0) score += 2
  }
  
  // Tool diversity (10% of score)
  const toolCount = Object.keys(stats.toolUsage).length
  if (toolCount > 10) score += 5
  else if (toolCount > 5) score += 3
  else if (toolCount > 2) score += 1
  
  return Math.min(100, Math.max(0, score))
}

function calculateUtilizationRate(stats: SessionStats): string {
  const avgSessionsPerDay = stats.totalSessions / Math.max(1, stats.days)
  const rate = Math.min(100, Math.round((avgSessionsPerDay / 10) * 100)) // Assuming 10 sessions/day is 100% utilization
  return `${rate}%`
}

function calculateCostEfficiency(stats: SessionStats): string {
  const avgTokensPerDollar = stats.totalCost > 0 
    ? (stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning) / stats.totalCost 
    : 0
  
  if (avgTokensPerDollar > 100000) return "Excellent"
  if (avgTokensPerDollar > 50000) return "Good"
  if (avgTokensPerDollar > 20000) return "Fair"
  return "Poor"
}

function getHealthStatus(stats: SessionStats): string {
  const score = calculateEfficiencyScore(stats)
  if (score >= 80) return "🟢 Healthy"
  if (score >= 60) return "🟡 Good"
  if (score >= 40) return "🟠 Warning"
  return "🔴 Critical"
}

function generateInsights(stats: SessionStats): string[] {
  const insights: string[] = []
  
  // Cost insights
  if (stats.costPerDay > 10) {
    insights.push("High daily cost detected - consider optimization")
  } else if (stats.costPerDay < 1) {
    insights.push("Cost-efficient usage pattern observed")
  }
  
  // Token efficiency insights
  const avgTokens = stats.totalSessions > 0 
    ? (stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning) / stats.totalSessions 
    : 0
  if (avgTokens > 10000) {
    insights.push("High token usage per session - review prompts")
  } else if (avgTokens < 1000) {
    insights.push("Optimal token efficiency maintained")
  }
  
  // Cache performance insights
  const totalTokens = stats.totalTokens.input + stats.totalTokens.output + stats.totalTokens.reasoning
  const cacheRate = totalTokens > 0 ? (stats.totalTokens.cache.read / totalTokens) * 100 : 0
  if (cacheRate < 5) {
    insights.push("Low cache hit rate - missing optimization opportunities")
  } else if (cacheRate > 20) {
    insights.push("Excellent cache utilization")
  }
  
  // Tool usage insights
  const topTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a).slice(0, 3)
  if (topTools.length > 0 && topTools[0][1] > stats.totalSessions) {
    insights.push(`High dependency on ${topTools[0][0]} tool`)
  }
  
  // Model diversity insights
  const modelCount = Object.keys(stats.modelUsage).length
  if (modelCount === 1) {
    insights.push("Single model dependency - consider diversification")
  } else if (modelCount > 3) {
    insights.push("Good model diversity for resilience")
  }
  
  return insights.slice(0, 5) // Limit to 5 insights
}

export interface SessionSnapshot {
  total_cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  message_count: number
  tool_usage: Record<string, number>
  model_usage: Record<string, { messages: number; tokens: { input: number; output: number }; cost: number }>
  primary_model: string | null
  title: string
  session_created_at: string | null
  session_updated_at: string | null
}

export async function computeSessionSnapshot(sessionID: string): Promise<SessionSnapshot> {
  const session = await Session.get(sessionID)
  const messages = await Session.messages({ sessionID }).catch(() => [] as any[])

  let totalCost = 0
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const toolUsage: Record<string, number> = {}
  const modelUsage: Record<string, { messages: number; tokens: { input: number; output: number }; cost: number }> = {}

  for (const message of messages) {
    if (message.info.role === "assistant") {
      totalCost += message.info.cost || 0

      const modelKey = `${message.info.providerID}/${message.info.modelID}`
      if (!modelUsage[modelKey]) {
        modelUsage[modelKey] = { messages: 0, tokens: { input: 0, output: 0 }, cost: 0 }
      }
      modelUsage[modelKey].messages++
      modelUsage[modelKey].cost += message.info.cost || 0

      if (message.info.tokens) {
        tokens.input += message.info.tokens.input || 0
        tokens.output += message.info.tokens.output || 0
        tokens.reasoning += message.info.tokens.reasoning || 0
        tokens.cacheRead += message.info.tokens.cache?.read || 0
        tokens.cacheWrite += message.info.tokens.cache?.write || 0
        modelUsage[modelKey].tokens.input += message.info.tokens.input || 0
        modelUsage[modelKey].tokens.output += (message.info.tokens.output || 0) + (message.info.tokens.reasoning || 0)
      }
    }

    for (const part of message.parts) {
      if (part.type === "tool" && part.tool) {
        toolUsage[part.tool] = (toolUsage[part.tool] || 0) + 1
      }
    }
  }

  const primaryModel = Object.entries(modelUsage).sort(([, a], [, b]) => b.messages - a.messages)[0]?.[0] ?? null

  return {
    total_cost: totalCost,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_reasoning: tokens.reasoning,
    tokens_cache_read: tokens.cacheRead,
    tokens_cache_write: tokens.cacheWrite,
    message_count: messages.length,
    tool_usage: toolUsage,
    model_usage: modelUsage,
    primary_model: primaryModel,
    title: session.title,
    session_created_at: session.time.created ? new Date(session.time.created).toISOString() : null,
    session_updated_at: session.time.updated ? new Date(session.time.updated).toISOString() : null,
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
