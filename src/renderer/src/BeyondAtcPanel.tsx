import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcConnectionStatus, BeyondAtcSettings, BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { BeyondAtcActions, BeyondAtcRadios } from './BeyondAtcControls'
import { buildClearanceReadout, type ClearanceReadout } from './beyondAtcClearanceReadout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const EMPTY_STATE: BeyondAtcState = {
  facility: null,
  com2: null,
  callsign: null,
  commsState: null,
  progress: null,
  actions: [],
  autoTune: null,
  autoRespond: null,
  frequencies: []
}

const SPEAKER_KEY: Record<BeyondAtcTranscriptEntry['speaker'], string> = {
  player: 'beyondAtcPanel.speaker.player',
  atc: 'beyondAtcPanel.speaker.atc',
  traffic: 'beyondAtcPanel.speaker.traffic',
  atcTraffic: 'beyondAtcPanel.speaker.atcTraffic'
}

function InfoField(props: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="text-muted-foreground">{props.label}: </span>
      <span className="font-medium text-foreground">{props.value}</span>
    </span>
  )
}

/** The top info strip (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md) —
 *  callsign/progress plus the boxed clearance readout, shrunk to one compact card with
 *  every field inline (a wrapped row), not stacked one-per-line. Deliberately doesn't show
 *  "tuned to" facility/COM2 info — that's `BeyondAtcRadios`' job now, per Callum's own call
 *  once the panel was actually split into cards. The live "who's talking" comms-mode
 *  indicator was dropped from here too (Callum's own call, 2026-09-29) — not shown anywhere
 *  on this panel any more. Always visible, same as every other card on this page — a
 *  placeholder while disconnected/nothing known yet, rather than disappearing and shifting
 *  the layout underneath it. */
function InfoCard(props: { state: BeyondAtcState; readout: ClearanceReadout }): React.JSX.Element {
  const { t } = useTranslation()
  const { callsign, progress } = props.state
  const r = props.readout
  const hasAnything = callsign || progress || Object.keys(r).length > 0
  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {!hasAnything && <span className="text-xs text-muted-foreground">{t('beyondAtcPanel.noStatus')}</span>}
        {callsign && <span className="text-sm font-semibold text-foreground">{callsign.full}</span>}
        {progress && (
          <span className="text-xs text-muted-foreground">
            {t('beyondAtcPanel.progress', { from: progress.from, to: progress.to, pct: progress.pct })}
          </span>
        )}
        {r.runway && <InfoField label={t('beyondAtcPanel.clearance.runway')} value={r.runway} />}
        {r.sidIdent && <InfoField label={t('beyondAtcPanel.clearance.sid')} value={r.sidIdent} />}
        {r.starIdent && <InfoField label={t('beyondAtcPanel.clearance.star')} value={r.starIdent} />}
        {r.approachIdent && <InfoField label={t('beyondAtcPanel.clearance.approach')} value={r.approachIdent} />}
        {r.approachTransition && <InfoField label={t('beyondAtcPanel.clearance.transition')} value={r.approachTransition} />}
        {r.altitudeFt !== undefined && (
          <InfoField label={t('beyondAtcPanel.clearance.altitude')} value={t('beyondAtcPanel.clearance.altitudeValue', { altitude: r.altitudeFt })} />
        )}
        {r.squawk && <InfoField label={t('beyondAtcPanel.clearance.squawk')} value={r.squawk} />}
        {r.nextFrequency && (
          <InfoField
            label={t('beyondAtcPanel.clearance.nextFrequency')}
            value={t('beyondAtcPanel.clearance.nextFrequencyValue', {
              station: r.nextFrequencyStation ?? '',
              frequency: r.nextFrequency
            })}
          />
        )}
      </CardContent>
    </Card>
  )
}

/** Always visible, like every other card on this page — a placeholder rather than
 *  disappearing entirely while disconnected or when BeyondATC has no menu currently
 *  offered. */
function ActionsCard(props: { actions: string[]; onSelectAction: (label: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('beyondAtcPanel.actions')}</CardTitle>
      </CardHeader>
      <CardContent>
        {props.actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.noActions')}</p>
        ) : (
          <BeyondAtcActions actions={props.actions} onSelectAction={props.onSelectAction} />
        )}
      </CardContent>
    </Card>
  )
}

function RadiosCard(props: React.ComponentProps<typeof BeyondAtcRadios>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('beyondAtcPanel.radios')}</CardTitle>
      </CardHeader>
      <CardContent>
        <BeyondAtcRadios {...props} />
      </CardContent>
    </Card>
  )
}

/** Always visible, same as `ActionsCard`'s Radios sibling — an empty scrollable box rather
 *  than disappearing entirely, so the right column doesn't jump around as the panel connects
 *  (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md). Fills the real, bounded
 *  height `BeyondAtcView`/`BeyondAtcPanel` propagate down from the window's own available
 *  space (`h-full` on `BeyondAtcView`'s root, `flex-1` the rest of the way down, all the way
 *  from App.tsx) — its own list never grows past that, scrolling internally instead
 *  (`min-h-0`/`flex-1` at every level down to the `<ul>` itself).
 *
 *  **The parent row is CSS Grid, not a flex row — this matters, confirmed the hard way.**
 *  A flexbox version (`flex flex-wrap items-stretch`) looked identical in the DOM (every
 *  `min-h-0`/`flex-1` class present at every level) but didn't actually cap this card:
 *  `align-items: stretch` on a flex-wrap row did not reliably give this column a definite
 *  height for its `min-h-0` descendants to resolve against, so the list just rendered at its
 *  full natural height regardless. Confirmed live via a Playwright screenshot + a DOM rect
 *  dump against a real 80-line transcript — the list grew to 1651px and the whole *page*
 *  scrolled to follow the newest line (via `scrollIntoView` below) instead of the card's own
 *  list, pushing every other card off screen entirely. Grid's track-sizing algorithm
 *  resolves a genuinely definite height for every cell in a row *before* laying out its
 *  contents — confirmed fixed with the identical rect dump afterward (452px, matching the
 *  left column, not 1651px). Kept as always-expanded (not collapsible), but scroll-anchored
 *  to the latest line: without that, a long transcript's newest exchange stays scrolled out
 *  of view within its own now-correctly-bounded box. */
function TranscriptCard(props: { entries: BeyondAtcTranscriptEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  const latestRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    latestRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.entries])

  return (
    <Card size="sm" className="min-h-0 flex-1">
      <CardHeader>
        <CardTitle>{t('beyondAtcPanel.transcript')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <ul className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto text-xs">
          {props.entries.map((entry, index) => (
            <li key={index} ref={index === props.entries.length - 1 ? latestRef : undefined} className="flex gap-1.5">
              <span className="shrink-0 font-medium text-foreground">{t(SPEAKER_KEY[entry.speaker])}:</span>
              <span className="text-muted-foreground">{entry.text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * BeyondATC integration's live panel (Parts 1-2 of flightdeck-backend's docs/plans/
 * beyondatc-integration.md) — its own top-level tab, same shape as GsxRemotePanel: current-
 * value fetches on mount plus live subscriptions, so a panel mounting (or remounting) after
 * BeyondATC already pushed state doesn't show nothing until the next line arrives.
 *
 * Card-grid layout (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md, second
 * design pass, 2026-09-29): a compact info strip on top, then a two-column area below —
 * Actions + Radios on the left (their own natural height, `self-start`), a Transcript on the
 * right that matches that height exactly with its own internal scroll. The row is CSS Grid
 * (`grid-cols-[minmax(18rem,28rem)_minmax(18rem,1fr)]`, roughly `DispatchView`'s own
 * `min-w-72 max-w-md flex-1` / `min-w-72 flex-1` column widths translated into grid tracks),
 * not flexbox — see `TranscriptCard`'s own doc comment for why that choice actually matters
 * here, not just style preference. `BeyondAtcView`'s `h-full` root is what gives this whole
 * area a real, window-bounded height to work with in the first place.
 */
export function BeyondAtcPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<BeyondAtcSettings | null>(null)
  const [status, setStatus] = useState<BeyondAtcConnectionStatus>({ state: 'disconnected', lastError: null })
  const [state, setState] = useState<BeyondAtcState>(EMPTY_STATE)
  const [transcript, setTranscript] = useState<BeyondAtcTranscriptEntry[]>([])
  const clearanceReadout = useMemo(() => buildClearanceReadout(transcript), [transcript])

  useEffect(() => {
    window.winglog.settingsGetBeyondAtc().then(setSettings)
    window.winglog.beyondAtcGetStatus().then(setStatus)
    window.winglog.beyondAtcGetState().then(setState)
    window.winglog.beyondAtcGetTranscript().then(setTranscript)
    const unsubscribeStatus = window.winglog.onBeyondAtcStatus(setStatus)
    const unsubscribeState = window.winglog.onBeyondAtcState(setState)
    const unsubscribeTranscript = window.winglog.onBeyondAtcTranscript(setTranscript)
    return () => {
      unsubscribeStatus()
      unsubscribeState()
      unsubscribeTranscript()
    }
  }, [])

  if (settings === null) return <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.loading')}</p>

  if (!settings.enabled) {
    return <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.notConfigured')}</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {status.state !== 'connected' && (
        <p className="text-xs text-muted-foreground">
          {status.state === 'connecting' ? t('beyondAtcPanel.connecting') : t('beyondAtcPanel.disconnected')}
        </p>
      )}
      <InfoCard state={state} readout={clearanceReadout} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-[minmax(18rem,28rem)_minmax(18rem,1fr)]">
        <div className="flex min-h-0 flex-col gap-4 self-start">
          <ActionsCard actions={state.actions} onSelectAction={(label) => window.winglog.beyondAtcSetAction(label)} />
          <RadiosCard
            facility={state.facility}
            com2={state.com2}
            progress={state.progress}
            onSetFrequency={(frequency) => window.winglog.beyondAtcSetFrequency(frequency)}
            onSetFrequencyCom2={(frequency) => window.winglog.beyondAtcSetFrequencyCom2(frequency)}
            frequencyOptions={state.frequencies}
            autoTune={state.autoTune}
            autoRespond={state.autoRespond}
            onSetAutoTune={(value) => window.winglog.beyondAtcSetAutoTune(value)}
            onSetAutoRespond={(value) => window.winglog.beyondAtcSetAutoRespond(value)}
          />
        </div>
        <div className="flex min-h-0 flex-col gap-4">
          <TranscriptCard entries={transcript} />
        </div>
      </div>
    </div>
  )
}
