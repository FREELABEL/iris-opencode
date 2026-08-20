import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, success, writeJson } from "./iris-api"

/**
 * Courses and certifications (#180765).
 *
 * The API for this existed the whole time and could not be called: every write sat behind
 * `auth:sanctum`, a guard fl-api does not define and has never installed, so all 18 routes
 * answered 401. The one real course on the platform was created by an artisan command. The
 * guard is fixed and the writes are authorized, so this can finally be driven from IRIS rather
 * than from a shell in a container — which is the whole point of it being platform work.
 *
 * Course endpoints live on FL_API (the default base), unlike playbooks which live on IRIS_API.
 */

const CourseListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list published courses",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Courses")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/courses`)
    if (!(await handleApiError(res, "List courses"))) { prompts.outro("Done"); return }

    const body = (await res.json()) as any
    const list: any[] = body?.data?.data ?? body?.data?.courses ?? body?.data ?? []
    if (args.json) { await writeJson(list); prompts.outro("Done"); return }

    printDivider()
    if (!list.length) console.log(`  ${dim("(no published courses)")}`)
    for (const c of list) {
      const title = c.title ?? c.program?.name ?? "Untitled"
      const cert = c.certificate_enabled ? dim(" · issues a certificate") : ""
      console.log(`  ${bold(String(title))}  ${dim(`#${c.id}`)}${cert}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const CourseGetCommand = cmd({
  command: "get <id>",
  describe: "show a course and flag any chapter that assesses nothing",
  builder: (yargs) =>
    yargs.positional("id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Course #${args.id}`)
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/courses/${args.id}`)
    if (!(await handleApiError(res, "Get course"))) { prompts.outro("Done"); return }

    const body = (await res.json()) as any
    const course = body?.data?.data ?? body?.data ?? body
    if (args.json) { await writeJson(course); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${bold(String(course?.title ?? course?.program?.name ?? "Untitled"))}`)
    const chapters: any[] = course?.chapters ?? []
    if (!chapters.length) console.log(`  ${dim("(no chapters yet)")}`)
    for (const ch of chapters) {
      const req = ch.is_required === false ? dim(" (optional)") : ""
      console.log(`  ${dim(String(ch.display_order ?? "").padStart(2))}  ${bold(String(ch.title))}  ${dim(`#${ch.id}`)}${req}`)
      // A chapter nobody can be examined on is the failure this whole line of work exists to
      // make visible: it would otherwise surface as a quiz that asks nothing and passes
      // everyone.
      const hasQuiz = ch.quiz_data && (ch.quiz_data.questions?.length ?? 0) > 0
      if (!hasQuiz) console.log(`      ${dim("⚠ no quiz — nothing is assessed in this chapter")}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const CourseCreateCommand = cmd({
  command: "create",
  describe: "create a course — you become its instructor and only you can change it",
  builder: (yargs) =>
    yargs
      .option("title", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("profile", { type: "number", describe: "creator profile id", default: 1 })
      .option("certificate", { type: "boolean", default: true, describe: "issues a certificate on completion" })
      .option("publish", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create course")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/courses`, {
      method: "POST",
      body: JSON.stringify({
        title: args.title,
        description: args.description ?? "",
        creator_profile_id: args.profile,
        certificate_enabled: args.certificate,
        is_published: args.publish,
      }),
    })
    if (!(await handleApiError(res, "Create course"))) { prompts.outro("Done"); return }

    const body = (await res.json()) as any
    const course = body?.data?.data ?? body?.data ?? {}
    // Ownership is stamped from the session, never from the request — say so, because it
    // decides who can edit this afterwards.
    prompts.outro(`${success("✓")} Course #${course.id ?? ""} created. You are its instructor; only you (or an admin) can change it.`)
  },
})

const ChapterAddCommand = cmd({
  command: "add <courseId>",
  describe: "add a chapter",
  builder: (yargs) =>
    yargs
      .positional("courseId", { type: "number", demandOption: true })
      .option("title", { type: "string", demandOption: true })
      .option("description", { type: "string", describe: "the reading material, if the chapter is text" })
      .option("optional", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add chapter")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const res = await irisFetch(`/api/v1/courses/${args.courseId}/chapters`, {
      method: "POST",
      body: JSON.stringify({
        title: args.title,
        description: args.description ?? "",
        is_required: !args.optional,
      }),
    })
    if (!(await handleApiError(res, "Add chapter"))) { prompts.outro("Done"); return }

    const body = (await res.json()) as any
    const ch = body?.data?.data ?? body?.data ?? {}
    if (!args.description) {
      // A chapter with no description and no content yet cannot be examined on anything.
      console.log(`  ${dim("⚠ no description — attach content or add one, or there is nothing to quiz on")}`)
    }
    prompts.outro(`${success("✓")} Chapter #${ch.id ?? ""} added.`)
  },
})

const CourseChaptersCommand = cmd({
  command: "chapters <subcommand>",
  describe: "chapters within a course",
  builder: (yargs) => yargs.command(ChapterAddCommand).demandCommand(1, ""),
  handler() {},
})

export const PlatformCourseCommand = cmd({
  command: "course <subcommand>",
  aliases: ["courses"],
  describe: "courses, chapters and certifications — what a worker must pass to be paid",
  builder: (yargs) =>
    yargs
      .command(CourseListCommand)
      .command(CourseGetCommand)
      .command(CourseCreateCommand)
      .command(CourseChaptersCommand)
      .demandCommand(1, ""),
  handler() {},
})
