import { Component, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { previewVoice, readAloudAvailable, readingId } from "@opencode-ai/session-ui/read-aloud"
import { createMediaQuery } from "@solid-primitives/media"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useUpdaterAction } from "../updater-action"
import { type GlowSpeed, useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { LayoutRetirementNotice, LayoutTransitionToggle } from "./interface-transition"
import {
  createAppearanceSettingsController,
  createPermissionScopeController,
  createShellOptions,
  createShellSettingsController,
  createMicrophoneSettingsController,
  createSoundSettingsController,
  soundOptions,
  type MicrophoneOption,
  type AppearanceSettingsController,
  type PermissionScopeController,
  type ShellSettingsController,
  type SoundSettingsController,
} from "./general-controllers"
import { CHAT_TEXT_SIZES, chatTextSize } from "@/utils/chat-text-size"
import { CHAT_FONTS, CHAT_SPACINGS } from "@/utils/chat-reading"
import "./settings-v2.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]
const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
} as const
const soundSettings = {
  agent: {
    action: "settings-sounds-agent",
    title: "settings.general.sounds.agent.title",
    description: "settings.general.sounds.agent.description",
  },
  permissions: {
    action: "settings-sounds-permissions",
    title: "settings.general.sounds.permissions.title",
    description: "settings.general.sounds.permissions.description",
  },
  errors: {
    action: "settings-sounds-errors",
    title: "settings.general.sounds.errors.title",
    description: "settings.general.sounds.errors.description",
  },
} as const

const PermissionScopeSetting: Component<{ controller: PermissionScopeController }> = (props) => {
  const language = useLanguage()
  return (
    <SettingsRowV2
      title={language.t("command.permissions.autoaccept.enable")}
      description={language.t("toast.permissions.autoaccept.on.description")}
    >
      <div data-action="settings-auto-accept-permissions">
        <Switch
          checked={props.controller.accepting()}
          disabled={!props.controller.enabled()}
          onChange={props.controller.set}
        />
      </div>
    </SettingsRowV2>
  )
}

const ShellSetting: Component<{ controller: ShellSettingsController }> = (props) => {
  const language = useLanguage()
  const options = createMemo(() =>
    createShellOptions({
      shells: props.controller.shells(),
      current: props.controller.current(),
    }),
  )
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.shell.title")}
      description={language.t("settings.general.row.shell.description")}
    >
      <SelectV2
        appearance="inline"
        data-action="settings-shell"
        options={options()}
        current={options().find((option) => option.value === props.controller.current()) ?? options()[0]}
        placement="bottom-end"
        gutter={6}
        value={(option) => option.id}
        label={(option) => {
          if (option.id === "auto") return language.t("settings.general.row.shell.autoDefault")
          if (!option.terminalOnly) return option.name
          return `${option.name} (${language.t("settings.general.row.shell.terminalOnly")})`
        }}
        onSelect={(option) => option && props.controller.select(option.value)}
      />
    </SettingsRowV2>
  )
}

const AppearanceSection: Component<{ controller: AppearanceSettingsController }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.appearance")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={schemeOptions}
            current={schemeOptions.find((option) => option === props.controller.scheme.current())}
            placement="bottom-end"
            gutter={6}
            label={(option) => {
              if (option === "system") return language.t("theme.scheme.system")
              if (option === "light") return language.t("theme.scheme.light")
              return language.t("theme.scheme.dark")
            }}
            onSelect={(option) => option && props.controller.scheme.select(option)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={language.t("settings.general.row.theme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={props.controller.theme.options()}
            current={props.controller.theme.current()}
            placement="bottom-end"
            gutter={6}
            value={(option) => option.id}
            label={(option) => option.name}
            onSelect={props.controller.theme.select}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.chatTextSize.title")}
          description={language.t("settings.general.row.chatTextSize.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-chat-text-size"
            options={[...CHAT_TEXT_SIZES]}
            current={chatTextSize(settings.appearance.fontSize())}
            placement="bottom-end"
            gutter={6}
            value={(size) => String(size)}
            label={(size) => language.t(`settings.general.row.chatTextSize.option.${size}` as "settings.general.row.chatTextSize.option.14")}
            onSelect={(size) => size && settings.appearance.setFontSize(size)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.chatFont.title")}
          description={language.t("settings.general.row.chatFont.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-chat-font"
            options={[...CHAT_FONTS]}
            current={settings.appearance.chatFont()}
            placement="bottom-end"
            gutter={6}
            value={(font) => font}
            label={(font) => language.t(`session.chatFont.${font}` as "session.chatFont.sans")}
            onSelect={(font) => font && settings.appearance.setChatFont(font)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.chatSpacing.title")}
          description={language.t("settings.general.row.chatSpacing.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-chat-spacing"
            options={[...CHAT_SPACINGS]}
            current={settings.appearance.chatSpacing()}
            placement="bottom-end"
            gutter={6}
            value={(spacing) => spacing}
            label={(spacing) => language.t(`session.chatSpacing.${spacing}` as "session.chatSpacing.default")}
            onSelect={(spacing) => spacing && settings.appearance.setChatSpacing(spacing)}
          />
        </SettingsRowV2>

        <FontSetting kind="ui" fonts={props.controller.fonts} />
        <FontSetting kind="code" fonts={props.controller.fonts} />
        <FontSetting kind="terminal" fonts={props.controller.fonts} />
      </SettingsListV2>
    </div>
  )
}

const FontSetting: Component<{
  kind: "ui" | "code" | "terminal"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInputV2
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRowV2>
  )
}

const SoundsSection: Component<{ controller: SoundSettingsController }> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>
      <SettingsListV2>
        <SoundSetting kind="agent" channel={props.controller.agent} />
        <SoundSetting kind="permissions" channel={props.controller.permissions} />
        <SoundSetting kind="errors" channel={props.controller.errors} />
      </SettingsListV2>
    </div>
  )
}

const GLOW_SPEEDS: GlowSpeed[] = ["calm", "normal", "fast"]

const WorkingGlowSection = () => {
  const language = useLanguage()
  const settings = useSettings()
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.workingGlow")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.glowRing.title")}
          description={language.t("settings.general.row.glowRing.description")}
        >
          <div data-action="settings-glow-ring">
            <Switch checked={settings.glow.ring()} onChange={(checked) => settings.glow.setRing(checked)} />
          </div>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.glowHalo.title")}
          description={language.t("settings.general.row.glowHalo.description")}
        >
          <div data-action="settings-glow-halo">
            <Switch
              checked={settings.glow.halo()}
              disabled={!settings.glow.ring()}
              onChange={(checked) => settings.glow.setHalo(checked)}
            />
          </div>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.glowBackground.title")}
          description={language.t("settings.general.row.glowBackground.description")}
        >
          <div data-action="settings-glow-background">
            <Switch checked={settings.glow.background()} onChange={(checked) => settings.glow.setBackground(checked)} />
          </div>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.glowSpeed.title")}
          description={language.t("settings.general.row.glowSpeed.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-glow-speed"
            options={GLOW_SPEEDS}
            current={settings.glow.speed()}
            value={(speed) => speed}
            label={(speed) => language.t(`settings.general.row.glowSpeed.${speed}`)}
            onSelect={(speed) => speed && settings.glow.setSpeed(speed)}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.glowReduceMotion.title")}
          description={language.t("settings.general.row.glowReduceMotion.description")}
        >
          <div data-action="settings-glow-reduce-motion">
            <Switch checked={settings.glow.reduceMotion()} onChange={(checked) => settings.glow.setReduceMotion(checked)} />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}

/** xAI streaming TTS voices; the first is xAI's default. Names are proper names, not translated. */
const SPEAK_VOICES = ["eve", "ara", "rex", "sal", "leo"]

const MicrophoneSection = () => {
  const language = useLanguage()
  const settings = useSettings()
  const controller = createMicrophoneSettingsController()
  const label = (option: MicrophoneOption) => {
    if (!option.name) return language.t("settings.general.row.microphone.systemDefault")
    if (!option.connected) return language.t("settings.general.row.microphone.notConnected", { name: option.name })
    return option.name
  }
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.microphone")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.microphone.title")}
          description={language.t("settings.general.row.microphone.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-microphone"
            options={controller.options()}
            current={controller.current()}
            value={(option) => option.name}
            label={label}
            onOpenChange={(open: boolean) => open && controller.refresh()}
            onSelect={controller.select}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.speakReplies.title")}
          description={language.t("settings.general.row.speakReplies.description")}
        >
          <div data-action="settings-speak-replies">
            <Switch
              checked={settings.voice.speakReplies()}
              onChange={(checked) => settings.voice.setSpeakReplies(checked)}
            />
          </div>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.speakVoice.title")}
          description={language.t("settings.general.row.speakVoice.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-speak-voice"
            options={SPEAK_VOICES}
            current={settings.voice.speakVoice() || SPEAK_VOICES[0]}
            value={(voice) => voice}
            label={(voice) => voice.charAt(0).toUpperCase() + voice.slice(1)}
            onSelect={(voice) => voice && settings.voice.setSpeakVoice(voice)}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}

/** Speeds people pick between; the value is the speech rate. */
const READ_SPEEDS = [
  { rate: 0.85, label: "Slower" },
  { rate: 1, label: "Normal" },
  { rate: 1.2, label: "Faster" },
  { rate: 1.5, label: "Fastest" },
]
type VoiceOption = { uri: string; label: string }

/**
 * Read aloud: the speaker button on IRIS's replies. Only this computer's own voices are offered
 * (localService), so it always works offline. Voices load late on some systems: listen for them.
 */
const ReadAloudSection = () => {
  const settings = useSettings()
  const [voices, setVoices] = createSignal<VoiceOption[]>([])
  const load = () => {
    const all = typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices()
    const lang = (navigator.language || "en").split("-")[0]!.toLowerCase()
    const local = all
      .filter((v) => v.localService)
      .sort((a, b) => {
        const am = a.lang.toLowerCase().startsWith(lang) ? 0 : 1
        const bm = b.lang.toLowerCase().startsWith(lang) ? 0 : 1
        return am - bm || a.name.localeCompare(b.name)
      })
      .map((v) => ({ uri: v.voiceURI, label: `${v.name} (${v.lang})` }))
    setVoices([{ uri: "", label: "System voice" }, ...local])
  }
  onMount(() => {
    load()
    if (typeof speechSynthesis === "undefined") return
    speechSynthesis.addEventListener("voiceschanged", load)
    onCleanup(() => speechSynthesis.removeEventListener("voiceschanged", load))
  })
  const options = () => ({ enabled: true, voice: settings.audio.voice(), rate: settings.audio.rate(), volume: 1 })
  return (
    <Show when={readAloudAvailable()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">Read aloud</h3>
        <SettingsListV2>
          <SettingsRowV2 title="Speaker button" description="Show a speaker on IRIS's replies. Click it to hear the reply. Works offline.">
            <div data-action="settings-read-aloud">
              <Switch checked={settings.audio.readAloud()} onChange={(checked) => settings.audio.setReadAloud(checked)} />
            </div>
          </SettingsRowV2>
          <SettingsRowV2 title="Voice" description="Voices on this computer.">
            <SelectV2
              appearance="inline"
              data-action="settings-read-aloud-voice"
              options={voices()}
              current={voices().find((v) => v.uri === settings.audio.voice()) ?? voices()[0]}
              value={(v) => v.uri}
              label={(v) => v.label}
              onSelect={(v) => v && settings.audio.setVoice(v.uri)}
              placement="bottom-end"
              gutter={6}
            />
          </SettingsRowV2>
          <SettingsRowV2 title="Speed" description="How fast IRIS reads.">
            <SelectV2
              appearance="inline"
              data-action="settings-read-aloud-speed"
              options={READ_SPEEDS}
              current={READ_SPEEDS.find((s) => s.rate === settings.audio.rate()) ?? READ_SPEEDS[1]}
              value={(s) => String(s.rate)}
              label={(s) => s.label}
              onSelect={(s) => s && settings.audio.setRate(s.rate)}
              placement="bottom-end"
              gutter={6}
            />
          </SettingsRowV2>
          <SettingsRowV2 title="Try it" description="Hear the voice and speed you picked.">
            <ButtonV2 data-action="settings-read-aloud-test" onClick={() => previewVoice(options())}>
              {readingId() === "__preview__" ? "Playing…" : "Play sample"}
            </ButtonV2>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
    </Show>
  )
}

const SoundSetting: Component<{
  kind: "agent" | "permissions" | "errors"
  channel: SoundSettingsController["agent"]
}> = (props) => {
  const language = useLanguage()
  const config = () => soundSettings[props.kind]
  return (
    <SettingsRowV2 title={language.t(config().title)} description={language.t(config().description)}>
      <SelectV2
        appearance="inline"
        data-action={config().action}
        options={soundOptions}
        current={props.channel.current()}
        value={(option) => option.id}
        label={(option) => language.t(option.label)}
        onHighlight={props.channel.highlight}
        onSelect={props.channel.select}
        placement="bottom-end"
        gutter={6}
      />
    </SettingsRowV2>
  )
}

const LanguageSetting = () => {
  const language = useLanguage()
  const options = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.language.title")}
      description={language.t("settings.general.row.language.description")}
    >
      <SelectV2
        appearance="inline"
        data-action="settings-language"
        options={options()}
        placement="bottom-end"
        gutter={6}
        current={options().find((option) => option.value === language.locale())}
        value={(option) => option.value}
        label={(option) => option.label}
        onSelect={(option) => option && language.setLocale(option.value)}
      />
    </SettingsRowV2>
  )
}

export const SettingsGeneralV2: Component<{
  sessionID?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const settings = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")
  const updater = useUpdaterAction()
  const permissionScope = createPermissionScopeController(() => props.sessionID)
  const shell = createShellSettingsController()
  const appearance = createAppearanceSettingsController()
  const sounds = createSoundSettingsController()
  const desktop = createMemo(() => platform.platform === "desktop")

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => desktop() && "getPinchZoomEnabled" in platform,
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const InterfaceSection = () => (
    <LayoutTransitionToggle
      title={language.t("settings.general.row.newInterface.title")}
      badge={language.t("settings.general.row.newInterface.badge")}
      description={language.t("settings.general.row.newInterface.description")}
      checked={settings.general.newLayoutDesigns()}
      onChange={(checked) => {
        settings.general.setNewLayoutDesigns(checked)
        if (checked) return
        void import("@/components/dialog-settings").then((module) => {
          void dialog.show(() => <module.DialogSettings />)
        })
      }}
    />
  )

  const InterfaceNoticeSection = () => (
    <LayoutRetirementNotice
      title={language.t("settings.general.row.newInterfaceNotice.title")}
      description={language.t("settings.general.row.newInterfaceNotice.description")}
      dismiss={language.t("settings.general.row.newInterfaceNotice.dismiss")}
      onDismiss={() => settings.general.dismissNewInterfaceNotice()}
    />
  )

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        <LanguageSetting />

        <PermissionScopeSetting controller={permissionScope} />

        <ShellSetting controller={shell} />

        <SettingsRowV2
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <Show when={mobile() && import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"}>
          <SettingsRowV2
            title={language.t("settings.general.row.mobileTitlebarBottom.title")}
            description={language.t("settings.general.row.mobileTitlebarBottom.description")}
          >
            <div data-action="settings-mobile-titlebar-bottom">
              <Switch
                checked={settings.general.mobileTitlebarPosition() === "bottom"}
                onChange={(checked) => settings.general.setMobileTitlebarPosition(checked ? "bottom" : "top")}
              />
            </div>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )

  const AdvancedSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.advanced")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.showFileTree.title")}
          description={language.t("settings.general.row.showFileTree.description")}
        >
          <div data-action="settings-show-file-tree">
            <Switch
              checked={settings.general.showFileTree()}
              onChange={(checked) => settings.general.setShowFileTree(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        {/*
          The setting people asked for. Two states here, three in the desktop menu: "off"
          is a real choice but a rare one, and putting it in a Switch would mean either a
          third control most people never want or a toggle that silently means two
          different things. Off stays reachable under IRIS > Automatic Updates.

          Hidden entirely when the platform cannot install anything (web), rather than
          rendering a dead control — see UpdaterPlatform.mode.
        */}
        <Show when={updater.mode && updater.setMode}>
          <SettingsRowV2
            title={language.t("settings.updates.row.auto.title")}
            description={
              updater.mode!() === "auto"
                ? language.t("settings.updates.row.auto.description")
                : language.t("settings.updates.row.auto.descriptionAsk")
            }
          >
            <div data-action="settings-auto-update">
              <Switch
                checked={updater.mode!() === "auto"}
                onChange={(checked) => void updater.setMode!(checked ? "auto" : "ask")}
              />
            </div>
          </SettingsRowV2>
        </Show>

        <SettingsRowV2
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={() => updater.run()}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  // We can probably remove this, right?
  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRowV2>
        </SettingsListV2>
      </div>
    </Show>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <Show when={settings.general.layoutTransitionAvailable()}>
          <InterfaceSection />
        </Show>

        <Show when={settings.general.newInterfaceNoticeVisible()}>
          <InterfaceNoticeSection />
        </Show>

        <GeneralSection />

        <AppearanceSection controller={appearance} />

        <NotificationsSection />

        <SoundsSection controller={sounds} />
        <MicrophoneSection />
        <ReadAloudSection />
        <WorkingGlowSection />

        <Show when={desktop()}>
          <UpdatesSection />
        </Show>

        <DisplaySection />

        <AdvancedSection />
      </div>
    </>
  )
}
