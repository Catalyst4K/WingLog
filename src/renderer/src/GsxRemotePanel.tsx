/** The GSX Remote tab's panel: GSX's menu, command bar, gate and service progress. */

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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAtcAssignedStand } from './useAtcAssignedStand'
import { useLiveClient, useLiveTopic } from './live/LiveClient'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  formatCargoProgress,
  formatFuelProgress,
  formatGsxBill,
  formatPaxProgress,
  gateSubtitle,
  hiddenServices,
  parseGsxParking,
  visibleServices
} from './gsx-remote-format'

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
 * GSX's own permanent title-bar toggle, mirrored directly (menu.js's own `menuHead`) — not
 * an optional extra. The menu tree only actually opens once something sends `menu.toggle`;
 * GSX's own client does this from exactly this always-visible header, entirely independent
 * of the in-sim panel. Passively displaying `state.menu` was never enough on its own
 * (confirmed live, 2026-09-21, docs/gsx-notes.md) — this is what actually opens it.
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
      className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-primary/10"
    >
      <span className="flex flex-col items-start gap-0.5">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={`size-4 shrink-0 text-primary transition-transform ${closed ? '' : 'rotate-90'}`}
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
function GateHeader(props: { gate: GsxRemoteGateInfo | null }): React.JSX.Element | null {
  if (!props.gate) return null
  const { gateLabel, area } = parseGsxParking(props.gate.parking)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-foreground">{gateLabel}</span>
      <span className="text-xs text-muted-foreground">{gateSubtitle(props.gate, area)}</span>
      {props.gate.gateProperties.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {props.gate.gateProperties.map((property) => (
            <Badge key={property} variant="outline" className="h-auto py-0 text-[10px] font-normal">
              {property}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

const RESTART_CONFIRM_MS = 4000
// GSX's own real timeout for its optimistic "downloading" state (menu.js's SB_TIMEOUT_MS) —
// matched, not invented, so a stuck reload clears at the same point GSX's own client would.
const SIMBRIEF_TIMEOUT_MS = 30000

/**
 * The three remotely-triggerable command-bar buttons (Customize Airport/Aircraft, Restart
 * Couatl) plus the separate, differently-styled SimBrief reload button — mirrors `menu.js`'s
 * own `commandBtn()`/`simbriefBtn()` behaviour, including RESTART_COUATL's tap-to-arm/tap-
 * to-confirm pattern and the SimBrief button's optimistic "Downloading..." state, both
 * confirmed live 2026-09-23 by reading GSX's own shipped source, not guessed.
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
  const simbriefLoading = simbriefClickGen !== null && !(typeof simbrief?.gen === 'number' && simbrief.gen > simbriefClickGen)

  useEffect(
    () => () => {
      clearTimeout(armedTimer.current)
      clearTimeout(simbriefTimer.current)
    },
    []
  )

  if (props.commandBar.commands.length === 0 && !simbrief) return null

  function handleCommandClick(id: 'CUSTOMIZE_AIRPORT_POSITION' | 'CUSTOMIZE_AIRPLANE' | 'RESTART_COUATL', confirm: boolean): void {
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
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('gsxRemotePanel.commands')}</p>
      <div className="flex flex-wrap gap-1.5">
        {props.commandBar.commands.map((c) => (
          <Button
            key={c.id}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto gap-1.5 py-1.5 text-xs"
            onClick={() => handleCommandClick(c.id, c.confirm)}
          >
            {c.iconUri && <img src={c.iconUri} alt="" className="size-4" />}
            {armed === c.id ? 'Confirm restart?' : c.label}
          </Button>
        ))}
      </div>
      {simbrief && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={simbriefLoading}
          className="h-auto w-full justify-start gap-1.5 py-1.5 text-xs"
          onClick={handleSimbriefClick}
        >
          {props.commandBar.simbriefIconUri && <img src={props.commandBar.simbriefIconUri} alt="" className="size-4" />}
          <span className="flex flex-col items-start">
            <span>{RELOAD_SIMBRIEF_LABEL}</span>
            {simbriefSub && <span className="text-[10px] font-normal text-muted-foreground">{simbriefSub}</span>}
          </span>
        </Button>
      )}
    </div>
  )
}

/**
 * GSX's own live menu entries, mirrored generically — not a semantic "click this service"
 * UI. GSX's own client (menu.js) "reads NO services array, recognizes NO ids/names"; this
 * does the same, on purpose (docs/gsx-notes.md, winglog-backend's docs/decisions.md,
 * 2026-09-21). Provider choice, when GSX asks, is just another snapshot of this same
 * `entries`/`icons`/`disabled` shape — rendering it generically is what makes that work
 * without a special case. Only shown while `menuShown` is true, exactly like GSX's own
 * client's own gate — entries can be stale/leftover while the menu itself is closed.
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
  const entries = props.menu.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry !== '')
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
            {props.menu.icons[index] ? <img src={props.menu.icons[index]} alt="" className="size-4 shrink-0" /> : null}
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
function GateSearchBox(props: { onSearch: (text: string) => void; atcStand: string | null }): React.JSX.Element {
  const { t } = useTranslation()
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
      {/* One click, never automatic (Callum, 2026-10-02): BeyondATC's own stand, for when its
       *  handoff to GSX didn't happen. */}
      {props.atcStand && (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => search(props.atcStand!)}>
          {t('gsxRemotePanel.atcStand', { stand: props.atcStand })}
        </Button>
      )}
    </div>
  )
}

/**
 * Structured `detail` fields (fuel current/target, pax/cargo counts) render as nicely
 * formatted numbers instead of `statusText`'s free text — real shapes confirmed live
 * 2026-09-21 (docs/gsx-notes.md, round 6/7 captures). Falls back to `statusText`/`stateText`
 * for every other service, unchanged from before. `detail.waitingFor` (real vehicle-pathing
 * stalls, confirmed live 2026-09-23, round 11) renders alongside whichever branch is active
 * rather than replacing it — GSX keeps reporting real pax/cargo counts even while stuck, and
 * the counts alone don't explain why they've stopped moving.
 *
 * @param props The service.
 * @returns The element, or null when there is nothing to show.
 */
function ServiceProgress(props: { service: GsxRemoteServiceStatus }): React.JSX.Element | null {
  const { t } = useTranslation()
  const detail = props.service.detail
  const waitingFor = detail?.waitingFor
  const waitingLine =
    waitingFor && waitingFor.length > 0 ? (
      <span className="text-amber-600 dark:text-amber-500">
        {t('gsxRemotePanel.waitingFor', { reason: waitingFor.join('; ') })}
      </span>
    ) : null

  if (detail?.fuel) {
    return (
      <span className="flex flex-col text-muted-foreground">
        {waitingLine}
        <span>{formatFuelProgress(detail.fuel)}</span>
      </span>
    )
  }
  if (detail?.pax) {
    return (
      <span className="flex flex-col text-muted-foreground">
        {waitingLine}
        <span>{formatPaxProgress(detail.pax)}</span>
        {detail.cargo?.map((cargo) => <span key={cargo.hold}>{formatCargoProgress(cargo)}</span>)}
      </span>
    )
  }
  const fallback = props.service.statusText || props.service.stateText
  if (!fallback && !waitingLine) return null
  return (
    <span className="flex flex-col text-muted-foreground">
      {waitingLine}
      {fallback && <span className="whitespace-pre-line">{fallback}</span>}
    </span>
  )
}

function ServiceRow(props: { service: GsxRemoteServiceStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const bill = props.service.detail?.bill
  return (
    <li className="flex flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">{props.service.displayName}</span>
        <span className="flex items-baseline gap-1.5 text-right text-muted-foreground">
          {props.service.operator && <span>{t('gsxRemotePanel.provider', { name: props.service.operator })}</span>}
          {typeof bill === 'number' && <span className="font-medium text-foreground">{formatGsxBill(bill)}</span>}
        </span>
      </div>
      <ServiceProgress service={props.service} />
    </li>
  )
}

function ServicesList(props: { services: GsxRemoteServiceStatus[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.services.length === 0) return null
  const visible = visibleServices(props.services)
  const hidden = hiddenServices(props.services)
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('gsxRemotePanel.services')}</p>
      <ul className="flex flex-col gap-1.5">
        {visible.map((service) => (
          <ServiceRow key={service.id} service={service} />
        ))}
      </ul>
      {hidden.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            />
            {t('gsxRemotePanel.showMoreServices', { count: hidden.length })}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {hidden.map((service) => (
              <ServiceRow key={service.id} service={service} />
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

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
      {props.prompt.description && <p className="text-xs text-muted-foreground">{props.prompt.description}</p>}
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
 * @returns The element.
 */
export function GsxRemotePanel(): React.JSX.Element {
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
    window.winglog.settingsGetGsxRemote().then(setSettings)
  }, [])

  if (settings === null) return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.loading')}</p>

  if (!settings.enabled || !settings.port) {
    return <p className="text-xs text-muted-foreground">{t('gsxRemotePanel.notConfigured')}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {status.state !== 'connected' && (
        <p className="text-xs text-muted-foreground">
          {status.state === 'connecting' ? t('gsxRemotePanel.connecting') : t('gsxRemotePanel.disconnected')}
        </p>
      )}
      {prompt && (
        <PromptModal
          prompt={prompt}
          onSubmit={(text) => live.command('gsx.submitPrompt', prompt.gen, text)}
          onCancel={() => live.command('gsx.cancelPrompt', prompt.gen)}
        />
      )}
      <GateHeader gate={gate} />
      <CommandBar commandBar={commandBar} onRun={(id) => live.command('gsx.runCommand', id)} />
      <MenuHeader menu={menu} onToggle={() => live.command('gsx.toggleMenu')} />
      <MenuEntries
        menu={menu}
        onPick={(index) => live.command('gsx.pickMenu', index)}
        onSearch={(text) => live.command('gsx.search', text)}
        atcStand={atcStand}
      />
      <ServicesList services={services} />
    </div>
  )
}
