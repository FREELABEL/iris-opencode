import { Match, Switch } from "solid-js"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { IrisMark } from "@/components/iris-mark"
import { markOf } from "./agent-mark-model"
import "./agent-mark.css"

// The Claude spark, in Claude's own orange; the shape is the one packages/ui ships for CLAUDE.md files.
const CLAUDE = "m1 2.73.726-.408.012-.036-.012-.02h-.035l-.122-.007-.415-.011-.36-.015-.35-.019-.087-.018-.082-.109.008-.054.074-.05.106.01.233.016.351.024.255.015.376.04h.06l.009-.025-.02-.015-.017-.015-.363-.246-.392-.26-.206-.15-.111-.075L.58 1.23l-.024-.155.101-.111.136.01.034.009.138.105.293.228.384.282.056.047.022-.016.003-.011-.025-.042-.209-.377-.222-.384-.1-.159-.025-.095a.5.5 0 0 1-.016-.112l.115-.157.063-.02.154.02.064.057.096.217.154.344.24.466.07.139.037.128.014.04h.024V1.66l.02-.263.036-.323L2.25.66l.012-.117.058-.14.115-.076.09.043.074.106-.01.068-.045.285-.086.447-.056.3h.033l.037-.038.152-.2.254-.319.113-.126.13-.14.085-.066h.159l.117.174-.053.18-.164.207-.135.176-.195.262-.121.21.011.016.029-.002.44-.094.237-.043.283-.049.129.06.014.061-.05.124-.304.075-.355.071-.53.126-.006.004.007.01.239.022.102.006h.25l.464.034.122.08.073.099-.012.075-.187.095-.253-.06-.59-.14-.201-.05h-.028v.016l.168.165.309.279.386.359.02.089-.05.07-.052-.008-.34-.255-.13-.115-.297-.25h-.02v.026l.068.1.361.543.02.166-.027.055-.094.032-.102-.018-.212-.297-.218-.334-.175-.299-.022.012-.104 1.118-.048.057-.113.043-.093-.071-.05-.115.05-.228.06-.296.048-.236.044-.292.026-.098-.001-.006-.022.003-.22.303-.336.453-.266.284-.064.026-.11-.057.01-.102.062-.091.368-.468.221-.29.143-.167v-.024h-.009l-.976.634-.174.022-.075-.07.01-.115.035-.037z"
// The Gemini sparkle, in Gemini's own gradient.
const GEMINI = "M15 8.014A7.457 7.457 0 0 0 8.014 15h-.028A7.456 7.456 0 0 0 1 8.014v-.028A7.456 7.456 0 0 0 7.986 1h.028A7.457 7.457 0 0 0 15 7.986z"

/**
 * The tool's own mark beside an agent session (#192985): Claude Code, Codex, Gemini, IRIS, Ollama.
 * Codex wears OpenAI's blossom, as the Codex app does; OpenAI and Ollama come from the provider sprite
 * in currentColor, so they follow the theme.
 */
export function AgentMark(props: { provider: string; class?: string }) {
  return (
    <span class={`agent-mark ${props.class ?? ""}`} data-mark={markOf(props.provider)} aria-hidden="true">
      <Switch fallback={<i>{(props.provider.trim()[0] ?? "?").toUpperCase()}</i>}>
        <Match when={markOf(props.provider) === "claude"}>
          <svg viewBox="0 0 4.233 4.233">
            <path fill="#D97757" d={CLAUDE} />
          </svg>
        </Match>
        <Match when={markOf(props.provider) === "gemini"}>
          <svg viewBox="0 0 16 16">
            <defs>
              <linearGradient id="agent-mark-gemini" x1="1" y1="15" x2="15" y2="1" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#4796E3" />
                <stop offset="0.55" stop-color="#9177C7" />
                <stop offset="1" stop-color="#CA6673" />
              </linearGradient>
            </defs>
            <path fill="url(#agent-mark-gemini)" d={GEMINI} />
          </svg>
        </Match>
        <Match when={markOf(props.provider) === "codex"}>
          <ProviderIcon id="openai" />
        </Match>
        <Match when={markOf(props.provider) === "ollama"}>
          <ProviderIcon id="ollama-cloud" />
        </Match>
        <Match when={markOf(props.provider) === "iris"}>
          <IrisMark />
        </Match>
      </Switch>
    </span>
  )
}
