import { cmd } from "./cmd"
import { ArticleDraftCommand } from "./article-draft"

// ============================================================================
// iris article — text in, publishable article out
//
// A sibling of `iris sop` and `iris playbook`: same recording, different document. An SOP is a
// procedure for a person, a playbook is one an agent runs, and an article is what you publish.
// They ask different questions of the same words, which is why they are separate commands
// rather than three renderings of one extraction.
//
// Only `draft` for now. Editing and linting an existing article exist as services
// (DocumentEditor, DocumentLinter) but have no CLI surface yet — tracked on bloq #503.
// ============================================================================

export const PlatformArticleCommand = cmd({
  command: "article",
  describe: "draft publishable articles from transcripts, notes, or recordings",
  builder: (yargs) => yargs.command(ArticleDraftCommand).demandCommand(),
  async handler() {},
})
