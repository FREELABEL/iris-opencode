import { createMemo, createResource, onMount, type Accessor } from "solid-js"
import type { ColorScheme } from "@opencode-ai/ui/theme/context"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { usePermission } from "@/context/permission"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { createSoundPreviewController, type ShellOption } from "./general-controller-behavior"

export { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"
export type { ShellOption, ShellSelectOption } from "./general-controller-behavior"

export function createPermissionScopeController(sessionID: Accessor<string | undefined>) {
  const permission = usePermission()
  const serverSync = useServerSync()
  const directory = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return serverSync().session.lineage.peek(id)?.session.directory
  })

  return {
    accepting: createMemo(() => {
      const id = sessionID()
      const dir = directory()
      if (!id || !dir) return false
      return permission.isAutoAccepting(id, dir)
    }),
    enabled: createMemo(() => !!directory()),
    set: (checked: boolean) => {
      const id = sessionID()
      const dir = directory()
      if (!id || !dir) return
      if (checked) return permission.enableAutoAccept(id, dir)
      permission.disableAutoAccept(id, dir)
    },
  }
}

export function createShellSettingsController() {
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const [shells] = createResource(
    async () => {
      const sdk = serverSdk()
      if ((await sdk.protocol) === "v1") return (await sdk.client.pty.shells()).data ?? []
      return [] as ShellOption[]
    },
    { initialValue: [] as ShellOption[] },
  )
  const current = createMemo(() => serverSync().data.config.shell ?? "")

  return {
    shells: () => shells.latest,
    current,
    select: (value: string) => {
      if (value === current()) return
      void serverSync().updateConfig({ shell: value })
    },
  }
}

export function createAppearanceSettingsController() {
  const settings = useSettings()
  const theme = useTheme()
  const themes = createMemo(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  onMount(() => void theme.loadThemes())

  return {
    scheme: {
      current: theme.colorScheme,
      select: (value: ColorScheme) => theme.setColorScheme(value),
    },
    theme: {
      options: themes,
      current: createMemo(() => themes().find((option) => option.id === theme.themeId())),
      select: (option: { id: string } | null) => option && theme.setTheme(option.id),
    },
    fonts: {
      ui: createMemo(() => ({
        value: sansInput(settings.appearance.uiFont()),
        family: sansFontFamily(settings.appearance.uiFont()),
        placeholder: sansDefault,
      })),
      code: createMemo(() => ({
        value: monoInput(settings.appearance.font()),
        family: monoFontFamily(settings.appearance.font()),
        placeholder: monoDefault,
      })),
      terminal: createMemo(() => ({
        value: terminalInput(settings.appearance.terminalFont()),
        family: terminalFontFamily(settings.appearance.terminalFont()),
        placeholder: terminalDefault,
      })),
      setUI: (value: string) => settings.appearance.setUIFont(value),
      setCode: (value: string) => settings.appearance.setFont(value),
      setTerminal: (value: string) => settings.appearance.setTerminalFont(value),
    },
  }
}

const noneSound = { id: "none", label: "sound.option.none" } as const
export const soundOptions = [noneSound, ...SOUND_OPTIONS]
export type SoundSelectOption = (typeof soundOptions)[number]

export function createSoundSettingsController() {
  const settings = useSettings()
  const preview = createSoundPreviewController(playSoundById)
  const channel = (
    enabled: Accessor<boolean>,
    current: Accessor<string>,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    current: createMemo(() =>
      enabled() ? (soundOptions.find((option) => option.id === current()) ?? noneSound) : noneSound,
    ),
    highlight: (option: SoundSelectOption | undefined) => {
      if (!option) return
      preview.play(option.id === "none" ? undefined : option.id)
    },
    select: (option: SoundSelectOption | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        preview.stop()
        return
      }
      setEnabled(true)
      set(option.id)
      preview.play(option.id)
    },
  })

  return {
    agent: channel(
      settings.sounds.agentEnabled,
      settings.sounds.agent,
      (value) => settings.sounds.setAgentEnabled(value),
      (id) => settings.sounds.setAgent(id),
    ),
    permissions: channel(
      settings.sounds.permissionsEnabled,
      settings.sounds.permissions,
      (value) => settings.sounds.setPermissionsEnabled(value),
      (id) => settings.sounds.setPermissions(id),
    ),
    errors: channel(
      settings.sounds.errorsEnabled,
      settings.sounds.errors,
      (value) => settings.sounds.setErrorsEnabled(value),
      (id) => settings.sounds.setErrors(id),
    ),
  }
}

export type PermissionScopeController = ReturnType<typeof createPermissionScopeController>
export type ShellSettingsController = ReturnType<typeof createShellSettingsController>
export type AppearanceSettingsController = ReturnType<typeof createAppearanceSettingsController>
export type SoundSettingsController = ReturnType<typeof createSoundSettingsController>

export type MicrophoneOption = { name: string; connected: boolean }

/**
 * Microphone picker. The choice is stored by device NAME ("" = system default) because the two
 * dictation recorders do not share an id space: the window recorder sees browser deviceIds, the
 * sidecar sees ffmpeg devices. So the list is the union of both views of the hardware.
 *
 * The window's list is only labelled once the page has been granted the microphone, and on macOS
 * the window's capture returns silence anyway — so the sidecar's list (GET /dictate/devices) is
 * the one that matters there. A server without that route answers with the SPA's HTML; anything
 * that is not a device list is ignored rather than shown as an error.
 */
export function createMicrophoneSettingsController() {
  const settings = useSettings()
  const serverSdk = useServerSDK()
  const [devices, { refetch }] = createResource(
    async () => {
      const [sidecar, window] = await Promise.all([sidecarDevices(serverSdk().url), windowDevices()])
      return [...new Set([...sidecar, ...window])]
    },
    { initialValue: [] as string[] },
  )
  const options = createMemo<MicrophoneOption[]>(() => {
    const listed = devices.latest.map((name) => ({ name, connected: true }))
    const saved = settings.voice.inputDevice()
    // A saved mic that is unplugged right now stays visible, so the setting is not silently
    // rewritten to "System default" by opening the picker.
    const missing = saved && !devices.latest.includes(saved) ? [{ name: saved, connected: false }] : []
    return [{ name: "", connected: true }, ...listed, ...missing]
  })

  return {
    options,
    current: createMemo(() => options().find((option) => option.name === settings.voice.inputDevice()) ?? options()[0]),
    select: (option: MicrophoneOption | null) => {
      if (!option) return
      settings.voice.setInputDevice(option.name)
    },
    refresh: () => void refetch(),
  }
}

async function sidecarDevices(base: string) {
  const res = await fetch(`${base.replace(/\/$/, "")}/dictate/devices`).catch(() => undefined)
  const body = await res?.json().catch(() => undefined)
  if (!Array.isArray(body?.devices)) return []
  return body.devices
    .map((device: { name?: unknown }) => (typeof device?.name === "string" ? device.name.trim() : ""))
    .filter((name: string) => name.length > 0)
}

async function windowDevices() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return []
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  return (
    all
      .filter((device) => device.kind === "audioinput" && device.label)
      // Chromium lists the default and communications devices twice, under these pseudo-ids.
      .filter((device) => device.deviceId !== "default" && device.deviceId !== "communications")
      .map((device) => device.label.trim())
  )
}
