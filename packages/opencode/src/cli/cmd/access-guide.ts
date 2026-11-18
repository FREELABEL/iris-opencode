// The access guide (#190012) — every kind of thing, every level of access, and the ONE link a
// person should be handed at each level. Printed under `iris exposure --help` and pointed at
// from every command that creates or shares something.
//
// Why it exists: asked for "the link" to a private epic, an agent had no command that answered,
// so it copied the shape of an old link out of a diary and handed out Elon's retired
// /iris/bloq/{id} route. The facts were all in the CLI — scattered across eight --help screens,
// none of which said which URL belongs to which audience. An agent reads --help; put it there.
//
// Keep this in step with the code that mints each address (bloq-web-url.ts, fl-api
// HasPublicUrl). The ladder's tier names are exposure-gate.ts TIERS.

export const ACCESS_GUIDE = `Who can open it — and the link to hand a person

  Never compose a link. Ask:  iris exposure show <ref>
    ref = note:<id> · board:<id> · page:<slug> · playbook:<name>
  It prints the tier and every working link with who it opens for.
  add-item, make-public, publish and share print their links too.

  Ladder, least to most reachable:  private · team · gated · unlisted · public
  Up to "gated" a person is identified. From "unlisted" up, the URL alone is the key.

  ATLAS BOARD
    private/team  https://heyiris.io/atlas?project=<bloq>
                  who: signed in, owner + members    set: iris bloqs add-member <bloq> --email <e>
    invite        a passwordless join link           set: iris bloqs invite <bloq>

  ATLAS ITEM · NOTE · HTML ARTIFACT  (an item on a board)
    private       https://heyiris.io/atlas?project=<bloq>&source=memory&row=<list>&card=<item>
                  who: signed in, board members      set: the default (add-item, atlas publish)
    gated         https://heyiris.io/n/<uuid>
                  who: named emails, domains, a password, or until a date
                  set: iris bloqs make-public <id> --allowed-emails | --allowed-domains |
                       --password | --expires
    public        https://heyiris.io/n/<uuid>
                  who: anyone with the link          set: iris bloqs make-public <id>
    undo          set: iris bloqs make-private <id>

  GENESIS PAGE  (composable or standalone HTML, served at /p/)
    draft         no /p/ link yet                    set: iris genesis preview <slug>
    private       /p/ is gone; /s/ share links work  set: iris genesis visibility <slug> private
    gated         https://heyiris.io/p/<slug>  + sign-in / email code
                                                     set: iris genesis set <slug> requires_auth true
    unlisted      https://heyiris.io/p/<slug>  works for anyone, not listed
                                                     set: iris genesis visibility <slug> unlisted
    public        https://heyiris.io/p/<slug>  listed and indexed
                                                     set: iris genesis publish <slug>
    one person    https://heyiris.io/s/<token>  expiring, revocable, works on a draft too
                                                     set: iris genesis share <slug> --expires 7d

  A signed-in Atlas link opens only for an account that can see the board. Anyone else is
  switched to one of THEIR projects without a message — check the board's members first.
  Retired: never hand out a board or item link on web.heyiris.io or web.freelabel.net (Elon).`

/** One line for the bottom of any command that creates or shares something. */
export const ACCESS_FOOTER =
  "Who can open it, and the link to give a person:  iris exposure show <ref>\n" +
  "Every access level and the link each one gives:  iris exposure --help"

/**
 * Append ACCESS_FOOTER under a command's --help without touching its builder. yargs 18 keeps
 * every epilogue (usage.epilog pushes), so a command's own epilogue survives.
 */
export function withAccessFooter<T extends { builder?: any }>(command: T): T {
  const original = command.builder
  return {
    ...command,
    builder: (y: any) => {
      const built = typeof original === "function" ? original(y) : original ? y.options(original) : y
      return (built ?? y).epilogue(ACCESS_FOOTER)
    },
  }
}
