import { relativeTime } from "@opencode-ai/ui/relative-time"

type TimeKey =
  | "common.time.justNow"
  | "common.time.minutesAgo.short"
  | "common.time.hoursAgo.short"
  | "common.time.daysAgo.short"
  | "common.time.yesterday"

type Translate = (key: TimeKey, params?: Record<string, string | number>) => string

/**
 * The app's translated relative time. One rule for the whole app (#194581): it is the ui
 * `relativeTime` — just now · 5m ago · 3h ago · yesterday · 4d ago · Nov 3 — in this app's words.
 */
export function getRelativeTime(dateString: string, t: Translate, now = Date.now()): string {
  return relativeTime(dateString, now, {
    words: {
      justNow: t("common.time.justNow"),
      minutesAgo: (count) => t("common.time.minutesAgo.short", { count }),
      hoursAgo: (count) => t("common.time.hoursAgo.short", { count }),
      yesterday: t("common.time.yesterday"),
      daysAgo: (count) => t("common.time.daysAgo.short", { count }),
    },
  })
}
