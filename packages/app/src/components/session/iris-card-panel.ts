/**
 * Atlas cards open in the side panel (#193330). The pure parts: where a card sits on its board,
 * and which card the step buttons go to. The board's own order (list by list, top to bottom) is
 * the order, so "next" is the card under this one, then the top of the next list.
 */

export type BoardOrder = { id: number; items: { id: number }[] }[]

/** Every card id on the board, list by list. Offline cards (negative ids) cannot open, so they are skipped. */
export function boardIds(lists: BoardOrder): number[] {
  return lists.flatMap((l) => l.items.map((i) => i.id)).filter((id) => id > 0)
}

/** Where `id` sits among `ids`, or undefined when it is not on the board as read (a search, a link). */
export function cardPosition(ids: number[], id: number): { index: number; total: number } | undefined {
  const index = ids.indexOf(id)
  return index < 0 ? undefined : { index, total: ids.length }
}

/** The card one step before (-1) or after (1) `id`; undefined at either end or off the board. */
export function stepCard(ids: number[], id: number, dir: -1 | 1): number | undefined {
  const index = ids.indexOf(id)
  if (index < 0) return undefined
  return ids[index + dir]
}

/** How a card opens. The panel unless the person last chose the pop-up (remembered per computer). */
export type CardMode = "panel" | "dialog"
export const CARD_MODE_KEY = "iris.atlas.cardMode"
export function readCardMode(get: (k: string) => string | null): CardMode {
  try {
    return get(CARD_MODE_KEY) === "dialog" ? "dialog" : "panel"
  } catch {
    return "panel"
  }
}
