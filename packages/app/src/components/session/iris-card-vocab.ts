/**
 * The card vocabulary shared by the card editor and the face editor. Its own module so neither
 * imports the other: the editor renders the face editor, and the face editor importing these
 * from the editor made a cycle that left the whole app blank at start-up (#190269).
 */
export interface SchemaOption {
  id: string
  label: string
  color?: string
}

/** The statuses the item column accepts. Mirrors the sidecar's ITEM_STATUSES; a schema id outside it is shown but cannot be written. */
export const WRITABLE_STATUSES = ["active", "pending", "approved", "rejected", "todo", "in_progress", "done"] as const
