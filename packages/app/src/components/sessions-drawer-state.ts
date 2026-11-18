import { createSignal } from "solid-js"

/**
 * Whether the sessions drawer (#190273) is open — apart from the drawer itself, so the title bar
 * can toggle it without importing the Home session list (and, through it, modules the unit-test
 * runner cannot load).
 */
const [open, setOpen] = createSignal(false)
export const sessionsDrawerOpen = open
export const setSessionsDrawerOpen = setOpen
export const toggleSessionsDrawer = () => setOpen((v) => !v)
