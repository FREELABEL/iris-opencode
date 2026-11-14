import { describe, expect, test } from "bun:test"
import { collectListFiltered } from "./platform-bloqs"

/**
 * #180303 — `iris bloqs items <bloq> -l <list>` returned nothing on any bloq
 * bigger than one page.
 *
 * The endpoint paginates over the WHOLE bloq; `--list` was applied afterwards, in
 * JS, to whichever page happened to come back. Bloq #503 holds 558 items, so at
 * the default page size of 50 the filter examined items 1–50 and reported "No
 * items found" for a list that has six. An empty result that looks like a
 * definitive answer is the worst shape a read can have — it is why an epic filed
 * into that list appeared, to me, not to exist.
 *
 * These tests drive a collector that keeps pulling pages until it has satisfied
 * the caller's limit or genuinely run out, and that reports honestly when it
 * stopped early.
 */

/** A fake server: `total` items, every `everyNth` one belonging to `listId`. */
function fakeFetcher(total: number, listId: number, everyNth: number) {
  const all = Array.from({ length: total }, (_, i) => ({
    id: 1000 + i,
    title: `item ${i}`,
    bloq_list_id: i % everyNth === 0 ? listId : 9999,
  }))
  let pagesFetched = 0
  return {
    get pagesFetched() {
      return pagesFetched
    },
    fetch: async (page: number, perPage: number) => {
      pagesFetched++
      const start = (page - 1) * perPage
      const slice = all.slice(start, start + perPage)
      return {
        items: slice,
        pagination: {
          total,
          current_page: page,
          last_page: Math.max(1, Math.ceil(total / perPage)),
          per_page: perPage,
        },
      }
    },
  }
}

describe("collectListFiltered", () => {
  test("finds matches that live beyond the first page (the #180303 repro)", async () => {
    // 558 items; the list's items start at index 500 — well past page 1 of 50.
    const server = fakeFetcher(558, 1449, 1)
    const all = Array.from({ length: 558 }, (_, i) => i)
    void all

    const late = {
      fetch: async (page: number, perPage: number) => {
        const items = Array.from({ length: perPage }, (_, i) => {
          const idx = (page - 1) * perPage + i
          return { id: 1000 + idx, title: `item ${idx}`, bloq_list_id: idx >= 500 ? 1449 : 9999 }
        }).filter((it) => it.id - 1000 < 558)
        return {
          items,
          pagination: { total: 558, current_page: page, last_page: Math.ceil(558 / perPage), per_page: perPage },
        }
      },
    }
    void server

    const result = await collectListFiltered(late.fetch, 1449, 10)

    expect(result.items.length).toBe(10)
    expect(result.items.every((i: any) => i.bloq_list_id === 1449)).toBe(true)
    // The count is the list's, not the board's: 58 items in list 1449 out of 558 on the
    // bloq. Reporting 558 made `items --list` claim items that were not in the list (#190628).
    expect(result.total).toBe(58)
    expect(result.complete).toBe(true)
  })

  test("stops as soon as the limit is satisfied — does not walk the whole bloq", async () => {
    const server = fakeFetcher(558, 1449, 2) // every other item matches
    const result = await collectListFiltered(server.fetch, 1449, 5)

    expect(result.items.length).toBe(5)
    expect(server.pagesFetched).toBe(1)
    expect(result.exhausted).toBe(true)
    // Filled the caller's page before the end of the bloq: the count is a lower bound.
    expect(result.total).toBe(100)
    expect(result.complete).toBe(false)
  })

  test("returns everything it found when the list has fewer items than the limit", async () => {
    const server = fakeFetcher(120, 1449, 40) // 3 matches in 120 items
    const result = await collectListFiltered(server.fetch, 1449, 50)

    expect(result.items.length).toBe(3)
    expect(result.total).toBe(3)
    expect(result.exhausted).toBe(true)
    expect(result.complete).toBe(true)
  })

  test("reports honestly when it gave up before the end", async () => {
    // A list whose items are all at the very end, with a page budget too small
    // to reach them. The answer is incomplete and must SAY so rather than
    // present an empty list as fact.
    const late = {
      fetch: async (page: number, perPage: number) => {
        const items = Array.from({ length: perPage }, (_, i) => {
          const idx = (page - 1) * perPage + i
          return { id: idx, title: `i${idx}`, bloq_list_id: idx >= 5000 ? 1449 : 1 }
        })
        return { items, pagination: { total: 6000, current_page: page, last_page: 30, per_page: perPage } }
      },
    }

    const result = await collectListFiltered(late.fetch, 1449, 10, 3)

    expect(result.items.length).toBe(0)
    expect(result.total).toBe(0)
    expect(result.exhausted).toBe(false) // <- the honesty bit
    expect(result.complete).toBe(false)
    expect(result.pagesScanned).toBe(3)
  })

  test("reports 0 for an empty list instead of the board's total (#190628)", async () => {
    const emptyList = {
      fetch: async () => ({
        items: [
          { id: 1, bloq_list_id: 9999 },
          { id: 2, bloq_list_id: 9999 },
          { id: 3, bloq_list_id: 9999 },
        ],
        pagination: { total: 3, current_page: 1, last_page: 1, per_page: 200 },
      }),
    }

    const result = await collectListFiltered(emptyList.fetch, 1449, 50)
    expect(result.items.length).toBe(0)
    // The bug said "3": pagination.total from the board leaked into a filtered read.
    expect(result.total).toBe(0)
    expect(result.complete).toBe(true)
  })

  test("matches on either list-id field the API has used", async () => {
    const mixed = {
      fetch: async () => ({
        items: [
          { id: 1, bloq_list_id: 1449 },
          { id: 2, list_id: 1449 },
          { id: 3, bloq_list_id: 7 },
        ],
        pagination: { total: 3, current_page: 1, last_page: 1, per_page: 50 },
      }),
    }

    const result = await collectListFiltered(mixed.fetch, 1449, 50)
    expect(result.items.map((i: any) => i.id)).toEqual([1, 2])
    expect(result.total).toBe(2)
    expect(result.complete).toBe(true)
  })
})
