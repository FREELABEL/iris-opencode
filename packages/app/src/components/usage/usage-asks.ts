import { trackPromptedOnce } from "@/utils/upgrade-funnel"
import { outCardState } from "@/pages/session/composer/allowance-dock-state"
import { usageAsk, type Offer, type UsagePlan } from "./usage-model"

type Post = (path: string, init?: RequestInit) => Promise<unknown>

/**
 * #191267: fl-iris-api already accepts `upgrade.prompted`, but nothing new ever SENT it. Every
 * surface that puts an ask to pay on screen calls this as it shows it; it sends once per kind per
 * app run (trackPromptedOnce) and only when that surface really is asking:
 * - "ring": the usage popover, when it shows Upgrade (never to someone who pays, never to staff);
 * - "out-card": the three choices at 100%, when the plan choice is on it.
 * The title bar pill ("almost" / "out") and a refusal ("refused") already send their own.
 */
export function announceAsk(post: Post, surface: "ring" | "out-card", plan: UsagePlan | undefined, offers: Offer[] = []): boolean {
  if (surface === "ring") return usageAsk(plan) === "upgrade" && trackPromptedOnce(post, "ring")
  return !!outCardState(plan, offers)?.upgrade && trackPromptedOnce(post, "out-card")
}
