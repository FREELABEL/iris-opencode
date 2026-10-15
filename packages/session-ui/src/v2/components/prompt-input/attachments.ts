import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { PromptInputV2Attachment, PromptInputV2Prompt } from "./types"
import { attachmentCheck, largeAttachmentNotice } from "./attachment-check"

export const accepted = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  // Read into text by the engine; the unreadable office formats stay pickable so the person is told why.
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  ".xlsx",
  ".xlsm",
  ".xls",
  ".ods",
  ".docx",
  ".doc",
  ".tsv",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]

type PromptTarget = {
  current: () => PromptInputV2Prompt
  cursor: () => number | undefined
  set: (prompt: PromptInputV2Prompt, cursor?: number) => void
}

export type PromptInputV2AttachmentConfig = {
  picker?: (
    options: { defaultPath?: string; multiple?: boolean; accept?: string[] },
    onFile: (file: File) => Promise<unknown>,
  ) => Promise<void>
  directory: () => string
  isDialogActive: () => boolean
  /** No message: the generic "unsupported" toast. A message: why THIS file was refused, and what to do. */
  warn: (message?: string) => void
  /** A file was attached but the model may not see all of it. */
  notice?: (message: string) => void
  duplicate: () => void
  onError: (error: unknown) => void
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
  store?: (file: File) => Promise<{ id: string; url: string }>
}

export function createPromptInputV2Attachments(
  input: PromptInputV2AttachmentConfig & {
    capture: () => PromptTarget
    editor: () => HTMLElement | undefined
    focusEditor: () => void
    addPart: (part: PromptInputV2Prompt[number]) => boolean
    setDraggingType: (type: "image" | "@mention" | null) => void
  },
) {
  const capture = () => {
    const prompt = input.capture()
    const editor = input.editor()
    if (!editor) return
    return { prompt, cursor: prompt.cursor() ?? cursorPosition(editor) }
  }
  const add = async (file: File, target = capture(), clipboard = false) => {
    if (!target) return false
    const check = await attachmentCheck(file)
    if (!check.ok) {
      // Always say which file and why — even inside a multi-file drop, where this used to stay
      // silent as long as one other file in the batch was accepted.
      input.warn(check.message)
      return false
    }
    const mime = check.mime
    const blob = input.store ? await input.store(file) : await blobReference(file)
    const sourcePath = input.getPathForFile?.(file) || undefined
    // Native clipboard images arrive with a fresh timestamped filename on every paste, so identical
    // clipboard content is matched on bytes alone.
    const duplicate = target.prompt
      .current()
      .some(
        (part) =>
          part.type === "image" &&
          part.blob.id === blob.id &&
          (sourcePath
            ? part.sourcePath === sourcePath
            : !part.sourcePath && (clipboard || part.filename === file.name)),
      )
    if (duplicate) {
      input.duplicate()
      return true
    }
    const attachment: PromptInputV2Attachment = {
      type: "image",
      id: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2),
      filename: file.name,
      sourcePath,
      mime,
      blob,
    }
    target.prompt.set([...target.prompt.current(), attachment], target.cursor)
    const notice = largeAttachmentNotice(file, mime)
    if (notice) input.notice?.(notice)
    return true
  }
  const addAttachments = async (files: File[], target = capture()) => {
    return files.reduce(async (result, file) => {
      const previous = await result
      return (await add(file, target)) || previous
    }, Promise.resolve(false))
  }
  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return
    const target = capture()
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length > 0) {
      await addAttachments(files, target)
      return
    }
    const plainText = clipboardData.getData("text/plain") ?? ""
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file && (await add(file, target, true))) return
    }
    if (!plainText) return
    const text = plainText.includes("\r") ? plainText.replace(/\r\n?/g, "\n") : plainText
    // A large paste is attached, not typed (#189434). Inserting it into the editor froze the app
    // for longer the bigger it was (measured: 200 lines 0.6s, 1,000 lines 7.2s, 5,000 lines
    // minutes). As an attachment it is held like a dropped .txt file (43ms) and sent in full.
    if (largePaste(text) && (await add(pastedTextFile(text), target, true))) return
    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }
    if (text.includes("\n") || largePaste(text)) {
      put()
      return
    }
    if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return
    put()
  }
  const handleDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return
    event.preventDefault()
    input.setDraggingType(null)
    const plainText = event.dataTransfer?.getData("text/plain")
    if (plainText?.startsWith("file:")) {
      const path = plainText.slice("file:".length)
      input.focusEditor()
      input.addPart({ type: "file", path, content: `@${path}`, start: 0, end: 0 })
      return
    }
    const files = event.dataTransfer?.files
    if (files) await addAttachments(Array.from(files))
  }

  onMount(() => {
    makeEventListener(document, "dragover", (event) => {
      if (input.isDialogActive()) return
      event.preventDefault()
      if (event.dataTransfer?.types.includes("Files")) input.setDraggingType("image")
      else if (event.dataTransfer?.types.includes("text/plain")) input.setDraggingType("@mention")
    })
    makeEventListener(document, "dragleave", (event) => {
      if (!input.isDialogActive() && !event.relatedTarget) input.setDraggingType(null)
    })
    makeEventListener(document, "drop", handleDrop)
  })

  return {
    addAttachments,
    handlePaste,
    handleDrop,
    pick(fallback: () => void) {
      if (!input.picker) {
        fallback()
        return
      }
      void input
        .picker({ defaultPath: input.directory(), multiple: true, accept: accepted }, (file) => add(file))
        .catch(input.onError)
    },
  }
}

async function blobReference(file: File) {
  const id = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return { id, url: URL.createObjectURL(file) }
}
function cursorPosition(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return 0
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().replace(/\u200B/g, "").length
}

/** Above this a paste becomes an attachment chip (#189434). Inline, 40 lines cost ~0.1s and 200 lines 0.6s. */
export const LARGE_PASTE_CHARS = 4000
export const LARGE_PASTE_LINES = 80

export function largePaste(text: string) {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines >= LARGE_PASTE_LINES) return true
  return false
}

/** The attachment a large paste becomes. The name is what the chip shows. */
export function pastedTextFile(text: string) {
  const lines = text.length === 0 ? 0 : text.split("\n").length
  return new File([text], `Pasted text · ${lines} ${lines === 1 ? "line" : "lines"}.txt`, { type: "text/plain" })
}
