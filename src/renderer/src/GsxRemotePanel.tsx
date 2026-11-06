/** The GSX Remote tab's panel: GSX's menu, command bar, gate and service progress. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import type {
  GsxRemoteCommandBar,
  GsxRemoteCommandId,
  GsxRemoteConnectionStatus,
  GsxRemoteGateInfo,
  GsxRemoteMenuState,
  GsxRemotePromptState,
  GsxRemoteServiceStatus,
  GsxRemoteSettings
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { useAtcAssignedStand } from './use-atc-assigned-stand'
import { useLiveClient, useLiveTopic } from './live/LiveClient'
import { StatusLight } from '@/components/StatusLight'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { gateSubtitle, parseGsxParking } from './gsx-remote-format'
import { ServicesList } from './GsxServices'
import { asyncHandler, runAsync } from './report-error'
import { GsxRoutines } from './GsxRoutines'

const EMPTY_MENU: GsxRemoteMenuState = {
  menuShown: false,
  searchActive: false,
  searchSession: 0,
  title: '',
  header: '',
  subtitle: '',
  entries: [],
  icons: [],
  disabled: [],
  layout: ''
}

const EMPTY_COMMAND_BAR: GsxRemoteCommandBar = { commands: [], simbrief: null, simbriefIconUri: null }

// GSX's own client text (menu.js), kept verbatim — same convention as gsxMenu.title/entries
// elsewhere in this feature: it's GSX's own product text, not ours to translate.
const RELOAD_SIMBRIEF_LABEL = 'Reload SimBrief'
const SEARCH_PARKING_PLACEHOLDER = 'Search parking...'
const SIMBRIEF_SUB_TEXT: Record<string, string> = {
  loading: 'Downloading...',
  loaded: 'Plan loaded',
  error: 'Error'
}

/**
 * GSX's permanent title-bar toggle, mirrored from menu.js's `menuHead`; not an optional extra. The menu tree only opens once
 * something sends `menu.toggle`, and GSX's own client does that from this always-visible header, independent of the in-sim
 * panel. Passively displaying `state.menu` was never enough (docs/gsx-notes.md).
 *
 * @param props The menu, and the collapse toggle.
 * @returns The element.
 */
function MenuHeader(props: { menu: GsxRemoteMenuState; onToggle: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const closed = !props.menu.menuShown
  const title = closed ? t('gsxRemotePanel.menuHeaderClosed') : props.menu.title || props.menu.header
  const subtitle = closed ? t('gsxRemotePanel.tapToOpen') : props.menu.subtitle
  return (
    <button
      type="button"
      onClick={props.onToggle}
      className="flex min-h-[72px] items-center justify-between gap-4 rounded-md border border-input bg-card px-5 text-left transition-colors hover:bg-muted/60"
    >
      <span className="flex flex-col items-start">
        <span className="text-lg font-semibold text-foreground">{title}</span>
        {subtitle && <span className="text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={`size-4 shrink-0 text-muted-foreground transition-transform ${closed ? '' : 'rotate-90'}`}
      />
    </button>
  )
}

/**
 * `gateProperties` is GSX's own free-text amenity-tag list ("jetway", "no stairs", "max
 * wingspan 70m") — rendered as plain badges, never matched against a fixed set, per
 * `gsx-remote-format.ts`'s own doc comment on the type.
 *
 * @param props The gate GSX resolved, or null.
 * @returns The element, or null when there is nothing to show.
 */
function GateHeader(props: { gate: GsxRemoteGateInfo | null; connected: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!props.gate && !props.connected) return null
  const parking = props.gate ? parseGsxParking(props.gate.parking) : null
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border pb-4">
      <div className="min-w-0">
        {props.gate && parking && (
          <>
            <h2 className="m-0 text-[26px] leading-tight font-semibold text-foreground">
              {parking.gateLabel}
            </h2>
            <p className="m-0 mt-0.5 text-[15px] text-muted-foreground">
              {gateSubtitle(props.gate, parking.area)}
            </p>
            {props.gate.gateProperties.length > 0 && (
              <p className="m-0 mt-1.5 text-[13px] text-muted-foreground">
                {props.gate.gateProperties.join(' · ')}
              </p>
            )}
          </>
        )}
      </div>
      {props.connected && (
        <span className="inline-flex items-center gap-2 pt-1.5 text-sm text-muted-foreground">
          <StatusLight state="green" />
          {t('gsxRemotePanel.connected')}
        </span>
      )}
    </header>
  )
}

const RESTART_CONFIRM_MS = 4000
// GSX's own real timeout for its optimistic "downloading" state (menu.js's SB_TIMEOUT_MS) —
// matched, not invented, so a stuck reload clears at the same point GSX's own client would.
const SIMBRIEF_TIMEOUT_MS = 30000

/**
 * The Reload SimBrief button: GSX's own label, and under way or done in its words, with a light once the plan is loaded.
 *
 * @param props The plan's status, GSX's icon, whether a reload is under way, the words beside the button, and the click handler.
 * @returns The element.
 */
function SimbriefButton(props: {
  status: string | undefined
  iconUri: string | null
  loading: boolean
  subText: string | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={props.loading}
      className="h-12 w-full justify-between gap-1.5 px-3.5 font-medium"
      onClick={props.onClick}
    >
      <span className="flex items-center gap-1.5">
        {props.iconUri && <img src={props.iconUri} alt="" className="size-4" />}
        {RELOAD_SIMBRIEF_LABEL}
      </span>
      {props.subText && (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-normal text-muted-foreground">
          {props.status === 'loaded' && !props.loading && <StatusLight state="green" />}
          {props.subText}
        </span>
      )}
    </Button>
  )
}

/**
 * The three remotely-triggerable command-bar buttons (Customize Airport/Aircraft, Restart Couatl) plus the separate,
 * differently-styled SimBrief reload button. Mirrors `menu.js`'s `commandBtn()`/`simbriefBtn()` behaviour, including
 * RESTART_COUATL's tap-to-arm/tap-to-confirm pattern and the SimBrief button's optimistic "Downloading..." state, as read from
 * GSX's shipped source.
 *
 * @param props The command bar, and the run handler.
 * @returns The element, or null when there is nothing to show.
 */
function CommandBar(props: {
  commandBar: GsxRemoteCommandBar
  onRun: (id: GsxRemoteCommandId) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [armed, setArmed] = useState<string | null>(null)
  const armedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The gen recorded at the moment "Reload SimBrief" was clicked, or null when no reload is
  // in flight — not "is it loading" as its own boolean. Whether it's *still* loading is
  // derived below, straight from comparing this against the live simbrief.gen (React's own
  // "don't sync state you can compute" guidance — mirrors simbriefBtn()'s own gen check
  // exactly, without needing an effect to keep a separate flag in sync with it).
  const [simbriefClickGen, setSimbriefClickGen] = useState<number | null>(null)
  const simbriefTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const simbrief = props.commandBar.simbrief
  const simbriefLoading =
    simbriefClickGen !== null && !(typeof simbrief?.gen === 'number' && simbrief.gen > simbriefClickGen)

  useEffect(
    () => () => {
      clearTimeout(armedTimer.current)
      clearTimeout(simbriefTimer.current)
    },
    []
  )

  if (props.commandBar.commands.length === 0 && !simbrief) return null

  function handleCommandClick(
    id: 'CUSTOMIZE_AIRPORT_POSITION' | 'CUSTOMIZE_AIRPLANE' | 'RESTART_COUATL',
    confirm: boolean
  ): void {
    if (confirm && armed !== id) {
      setArmed(id)
      clearTimeout(armedTimer.current)
      armedTimer.current = setTimeout(() => setArmed(null), RESTART_CONFIRM_MS)
      return
    }
    setArmed(null)
    clearTimeout(armedTimer.current)
    props.onRun(id)
  }

  function handleSimbriefClick(): void {
    setSimbriefClickGen(typeof simbrief?.gen === 'number' ? simbrief.gen : -1)
    clearTimeout(simbriefTimer.current)
    // Safety fallback only — the real clear happens above, the moment GSX's own gen bump
    // arrives and this component re-renders; this timer only fires if that never happens.
    simbriefTimer.current = setTimeout(() => setSimbriefClickGen(null), SIMBRIEF_TIMEOUT_MS)
    props.onRun('RELOAD_SIMBRIEF')
  }

  // GSX's own client text (menu.js's simbriefBtn), kept verbatim, same as the command
  // labels below — not ours to translate.
  const simbriefSub = simbriefLoading
    ? SIMBRIEF_SUB_TEXT.loading
    : simbrief?.status === 'loaded'
      ? SIMBRIEF_SUB_TEXT.loaded
      : simbrief?.status === 'error'
        ? simbrief.error || SIMBRIEF_SUB_TEXT.error
        : null

  return (
    <section
      className="flex flex-col gap-3 rounded-md bg-card px-5 pt-4 pb-[18px]"
      aria-label={t('gsxRemotePanel.commands')}
    >
      <h3 className="m-0 text-[17px] font-semibold text-foreground">{t('gsxRemotePanel.commands')}</h3>
      <div className="flex flex-col gap-2">
        {simbrief && (
          <SimbriefButton
            status={simbrief.status}
            iconUri={props.commandBar.simbriefIconUri}
            loading={simbriefLoading}
            subText={simbriefSub}
            onClick={handleSimbriefClick}
          />
        )}
        {props.commandBar.commands.map((c) => (
          <Button
            key={c.id}
            type="button"
            variant={c.id === 'RESTART_COUATL' ? 'destructive' : 'outline'}
            className="h-12 w-full justify-start gap-1.5 px-3.5 font-medium"
            onClick={() => handleCommandClick(c.id, c.confirm)}
          >
            {c.iconUri && <img src={c.iconUri} alt="" className="size-4" />}
            {armed === c.id ? 'Confirm restart?' : c.label}
          </Button>
        ))}
      </div>
    </section>
  )
}

/**
 * GSX's live menu entries, mirrored generically, not a semantic "click this service" UI. GSX's client (menu.js) "reads NO
 * services array, recognizes NO ids/names"; this does the same on purpose.
 * Provider choice, when GSX asks, is another snapshot of the same `entries`/`icons`/`disabled` shape, so rendering generically
 * needs no special case. Only shown while `menuShown` is true, like GSX's own client: entries can be stale while the menu is
 * closed.
 *
 * @param props The menu, the pick and search handlers, and the stand BeyondATC assigned.
 * @returns The element.
 */
function MenuEntries(props: {
  menu: GsxRemoteMenuState
  onPick: (index: number) => void
  onSearch: (text: string) => void
  /** The stand BeyondATC assigned, offered in the gate search (useAtcAssignedStand). */
  atcStand: string | null
}): React.JSX.Element | null {
  if (!props.menu.menuShown) return null
  // GSX pads the gate-search list to a fixed page with empty strings — skipped here, as
  // GSX's own menu.js does, but each real entry keeps its original index for `menu.pick`.
  const entries = props.menu.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry !== '')
  if (entries.length === 0 && !props.menu.searchActive) return null
  return (
    <div className="flex flex-col gap-1.5">
      {props.menu.searchActive && (
        // Keyed by session so a fresh search starts with an empty box, not the last query.
        <GateSearchBox key={props.menu.searchSession} onSearch={props.onSearch} atcStand={props.atcStand} />
      )}
      <div className="grid grid-cols-3 gap-1.5">
        {entries.map(({ entry, index }) => (
          <Button
            key={`${index}-${entry}`}
            type="button"
            variant="outline"
            size="sm"
            disabled={props.menu.disabled[index] === true}
            className="h-auto min-h-9 whitespace-normal py-1.5 text-xs"
            onClick={() => props.onPick(index)}
          >
            {props.menu.icons[index] ? (
              <img src={props.menu.icons[index]} alt="" className="size-4 shrink-0" />
            ) : null}
            {entry}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * GSX's live gate-search box, shown while `state.search.active` (the menu GSX opens after
 * "Search parking..." is picked). Mirrors `menu.js`'s own `buildSearchBox()` exactly: every
 * keystroke sends the box's *whole* current text as `menu.search`, and GSX re-filters the
 * menu entries itself — no local filtering or debouncing (docs/gsx-notes.md, round 11).
 *
 * @param props The search handler, and the stand BeyondATC assigned.
 * @returns The element.
 */
function GateSearchBox(props: {
  onSearch: (text: string) => void
  atcStand: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const atcStand = props.atcStand
  const [text, setText] = useState('')
  const search = (value: string): void => {
    setText(value)
    props.onSearch(value)
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="search"
        value={text}
        placeholder={SEARCH_PARKING_PLACEHOLDER}
        aria-label={SEARCH_PARKING_PLACEHOLDER}
        autoFocus
        onChange={(e) => search(e.target.value)}
      />
      {/* One click, never automatic: BeyondATC's own stand, for when its
       *  handoff to GSX didn't happen. */}
      {atcStand && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => search(atcStand)}
        >
          {t('gsxRemotePanel.atcStand', { stand: atcStand })}
        </Button>
      )}
    </div>
  )
}

/**
 * The dialog for a GSX prompt that asks for text.
 *
 * @param props The prompt, and what to do with the answer or a cancel.
 * @returns The dialog.
 */
function PromptModal(props: {
  prompt: GsxRemotePromptState
  onSubmit: (text: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(props.prompt.default)

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      <p className="text-sm font-medium text-foreground">{props.prompt.title}</p>
      {props.prompt.description && (
        <p className="text-xs text-muted-foreground">{props.prompt.description}</p>
      )}
      <Label className="flex flex-col items-start gap-1.5">
        <Input
          type="text"
          value={text}
          maxLength={props.prompt.maxLength || undefined}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
      </Label>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
          {t('gsxRemotePanel.cancel')}
        </Button>
        <Button type="button" size="sm" onClick={() => props.onSubmit(text)}>
          {t('gsxRemotePanel.ok')}
        </Button>
      </div>
    </div>
  )
}

// Stable initial values for useLiveTopic (a fresh literal each render would be harmless,
// but these read better as named defaults).
const DISCONNECTED: GsxRemoteConnectionStatus = { state: 'disconnected', lastError: null }
const NO_SERVICES: GsxRemoteServiceStatus[] = []

/**
 * The GSX Remote panel, live from GSX's state.
 *
 * @param props `canEditRoutines`: whether the routine editor is offered; the PC's window does, a phone does not.
 * @returns The element.
 */
export function GsxRemotePanel(props: { canEditRoutines?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<GsxRemoteSettings | null>(null)
  // Live state through the LiveClient (live-data-seam.md, part C), each fetched on mount as
  // well as followed — GSX only pushes services/menu/prompt on a *change*, so a panel
  // mounting (or remounting, e.g. switching tabs and back) after GSX already sent its
  // snapshot would otherwise show nothing until the next patch. Real gap found writing this
  // feature's first Playwright test (winglog-backend's docs/plans/gsx-remote-control.md).
  const live = useLiveClient()
  const status = useLiveTopic('gsxRemoteStatus', DISCONNECTED)
  const services = useLiveTopic('gsxRemoteServices', NO_SERVICES)
  const gate = useLiveTopic('gsxRemoteGate', null)
  const menu = useLiveTopic('gsxRemoteMenu', EMPTY_MENU)
  const prompt = useLiveTopic('gsxRemotePrompt', null)
  const commandBar = useLiveTopic('gsxRemoteCommandBar', EMPTY_COMMAND_BAR)
  const atcStand = useAtcAssignedStand()

  useEffect(() => {
    runAsync('GsxRemotePanel settingsGetGsxRemote', winglogApi().settingsGetGsxRemote().then(setSettings))
  }, [])

  if (settings === null) return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.loading')}</p>

  if (!settings.enabled || !settings.port) {
    return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.notConfigured')}</p>
  }

  return (
    <div className="@container flex flex-col gap-5">
      {status.state !== 'connected' && (
        <p className="text-sm text-muted-foreground">
          {status.state === 'connecting' ? t('gsxRemotePanel.connecting') : t('gsxRemotePanel.disconnected')}
        </p>
      )}
      {prompt && (
        <PromptModal
          prompt={prompt}
          onSubmit={asyncHandler('GsxRemotePanel gsx.submitPrompt', (text) =>
            live.command('gsx.submitPrompt', prompt.gen, text)
          )}
          onCancel={asyncHandler('GsxRemotePanel gsx.cancelPrompt', () =>
            live.command('gsx.cancelPrompt', prompt.gen)
          )}
        />
      )}
      <GateHeader gate={gate} connected={status.state === 'connected'} />
      {/* As on the canvas (r3-gsx): the menu and the services on the left, the routines and the commands on the right; one column when narrow. */}
      <div className="flex flex-col items-start gap-6 @2xl:flex-row">
        <div className="flex w-full min-w-0 flex-col gap-5 @2xl:flex-[1.4_1_0]">
          <MenuHeader
            menu={menu}
            onToggle={asyncHandler('GsxRemotePanel gsx.toggleMenu', () => live.command('gsx.toggleMenu'))}
          />
          <MenuEntries
            menu={menu}
            onPick={asyncHandler('GsxRemotePanel gsx.pickMenu', (index) =>
              live.command('gsx.pickMenu', index)
            )}
            onSearch={asyncHandler('GsxRemotePanel gsx.search', (text) => live.command('gsx.search', text))}
            atcStand={atcStand}
          />
          <ServicesList services={services} />
        </div>
        <div className="flex w-full min-w-0 flex-col gap-5 @2xl:flex-1">
          <GsxRoutines canEdit={props.canEditRoutines ?? true} />
          <CommandBar
            commandBar={commandBar}
            onRun={asyncHandler('GsxRemotePanel gsx.runCommand', (id) => live.command('gsx.runCommand', id))}
          />
        </div>
      </div>
    </div>
  )
}
