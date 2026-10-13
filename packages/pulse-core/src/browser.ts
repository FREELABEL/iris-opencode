/**
 * Entry for the browser bundle (dist/pulse-core.iife.js). A Genesis page loads that file with a
 * plain <script> tag and reads everything off window.IrisPulseCore — no module loader needed.
 */
import * as IrisPulseCore from "./index"

;(globalThis as unknown as { IrisPulseCore: typeof IrisPulseCore }).IrisPulseCore = IrisPulseCore

export {}
