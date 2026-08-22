import type { CommandModule } from "yargs"
import { cmd } from "./cmd"

// ============================================================================
// product-command — one shape for every IRIS product front door (#181888)
//
// A PRODUCT is a thing a client recognises as something they bought: Lexicon,
// Atlas, Genesis, Hive. A COMMAND is how they reach it. Those two drifted apart
// one release at a time, because nothing at release time ever asked "does this
// product have a front door?" — an audit in Aug 2026 found twelve products
// spread across four different behaviours.
//
// This makes the shape declarative, so a product cannot half-exist: it either
// declares a purpose and keywords or it does not compile as a product.
//
// The keywords are the leverage. Help stays short and does NOT enumerate the
// docs; it emits the product's keyword set and hands the reader the query that
// makes the how-to / playbook index do the work. New recipes then surface at
// the front door without anyone editing a help string.
//
// Gate 22 of the production-deploy playbook verifies the result by RUNNING
// `iris <product> --help`, never by grepping for this registration.
// ============================================================================

export interface ProductSpec {
  /** The product name as a client says it — becomes `iris <name>`. */
  name: string
  /** Other names people actually type. */
  aliases?: string[]
  /** One line, client language, what the product is FOR. Not a feature list. */
  purpose: string
  /** Terms that should find this product in the how-to / playbook index. */
  keywords: string[]
  /** How-to slugs worth naming explicitly at the front door. */
  howtos?: string[]
  /** Playbook names this product runs on. */
  playbooks?: string[]
  /** The product's subcommands. */
  subcommands: CommandModule<any, any>[]
}

/** Registry of every declared product, so Gate 22 and `iris help` can enumerate them. */
export const PRODUCTS: ProductSpec[] = []

export function productEpilogue(spec: ProductSpec): string {
  const lines: string[] = []
  if (spec.howtos?.length) {
    lines.push("How-tos:")
    for (const h of spec.howtos) lines.push(`  iris how-to view ${h}`)
  }
  if (spec.playbooks?.length) {
    lines.push("Playbooks:")
    for (const p of spec.playbooks) lines.push(`  iris playbook run ${p}`)
  }
  if (spec.keywords.length) {
    lines.push(`Keywords: ${spec.keywords.join(" · ")}`)
    // The index does the work — help does not have to list what it finds.
    lines.push(`  iris how-to search ${spec.keywords[0]}`)
  }
  return lines.join("\n")
}

export function productCommand(spec: ProductSpec) {
  PRODUCTS.push(spec)
  return cmd({
    command: spec.name,
    aliases: spec.aliases ?? [],
    describe: spec.purpose,
    builder: (yargs: any) => {
      let y = yargs
      for (const sub of spec.subcommands) y = y.command(sub)
      return y.epilogue(productEpilogue(spec)).demandCommand()
    },
    async handler() {},
  })
}
