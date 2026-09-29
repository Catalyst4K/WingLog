import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcConnectionStatus, BeyondAtcSettings, BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { BeyondAtcActionsPanel } from './BeyondAtcActionsPanel'
import { buildClearanceReadout, type ClearanceReadout } from './beyondAtcClearanceReadout'

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

const COMMS_MODE_KEY: Record<NonNullable<BeyondAtcState['commsState']>['mode'], string> = {
  queued: 'beyondAtcPanel.commsMode.queued',
  ready: 'beyondAtcPanel.commsMode.ready',
  awaiting: 'beyondAtcPanel.commsMode.awaiting',
  speaking: 'beyondAtcPanel.commsMode.speaking',
  request: 'beyondAtcPanel.commsMode.request',
  traffic: 'beyondAtcPanel.commsMode.traffic'
}

const SPEAKER_KEY: Record<BeyondAtcTranscriptEntry['speaker'], string> = {
  player: 'beyondAtcPanel.speaker.player',
  atc: 'beyondAtcPanel.speaker.atc',
  traffic: 'beyondAtcPanel.speaker.traffic',
  atcTraffic: 'beyondAtcPanel.speaker.atcTraffic'
}

/** The comms-status card — the panel's primary glance target, matching `GsxRemotePanel`'s
 *  `MenuHeader` in visual weight (bordered, tinted) so it reads as the clear top anchor
 *  rather than one paragraph among several. Callsign/facility/progress and the live
 *  "who's talking/awaiting" indicator (`CommsState.mode`, confirmed live via a real Radio
 *  Check trace, docs/beyondatc-notes.md) are one card, not separate stacked pieces — status
 *  is what a pilot glances at first, Actions below is secondary
 *  (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md). `commsState.text` is
 *  BeyondATC's own text (e.g. "Radio Check"), shown verbatim alongside the translated mode
 *  label, same "third-party text, not translated" precedent GsxRemotePanel sets for GSX's
 *  own menu labels. */
function StatusCard(props: { state: BeyondAtcState }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { facility, callsign, progress, commsState } = props.state
  if (!facility && !callsign && !progress && !commsState) return null
  return (
    <div className="flex flex-col gap-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5 shadow-sm">
      {callsign && <span className="text-sm font-semibold text-foreground">{callsign.full}</span>}
      {facility && (
        <span className="text-xs text-muted-foreground">
          {t('beyondAtcPanel.tunedTo', { station: facility.name, frequency: facility.frequency })}
        </span>
      )}
      {progress && (
        <span className="text-xs text-muted-foreground">
          {t('beyondAtcPanel.progress', { from: progress.from, to: progress.to, pct: progress.pct })}
        </span>
      )}
      {commsState && (
        <span className="text-xs text-muted-foreground">
          {t(COMMS_MODE_KEY[commsState.mode])}
          {commsState.text ? ` — ${commsState.text}` : ''}
        </span>
      )}
    </div>
  )
}

function ClearanceField(props: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span className="font-medium text-foreground">{props.value}</span>
    </div>
  )
}

/** The boxed clearance readout (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md,
 *  item 4) — distinct labelled fields instead of a wall of transcript text, built from
 *  `beyondAtcClearanceReadout.ts`'s real-capture-based parser. Layout is WingLog's own take
 *  (a labelled grid, matching this panel's/`GsxRemotePanel`'s existing card style) rather
 *  than a pixel copy of BeyondATC's own toolbar UI — that toolbar's markup wasn't available
 *  to read in this environment, only its command vocabulary (docs/beyondatc-notes.md) was
 *  already on file. Hidden entirely until the first recognised clearance line arrives. */
function ClearanceCard(props: { readout: ClearanceReadout }): React.JSX.Element | null {
  const { t } = useTranslation()
  const r = props.readout
  if (Object.keys(r).length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2">
      <p className="text-sm font-medium text-foreground">{t('beyondAtcPanel.clearance.title')}</p>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-xs">
        {r.runway && <ClearanceField label={t('beyondAtcPanel.clearance.runway')} value={r.runway} />}
        {r.sidIdent && <ClearanceField label={t('beyondAtcPanel.clearance.sid')} value={r.sidIdent} />}
        {r.starIdent && <ClearanceField label={t('beyondAtcPanel.clearance.star')} value={r.starIdent} />}
        {r.approachIdent && <ClearanceField label={t('beyondAtcPanel.clearance.approach')} value={r.approachIdent} />}
        {r.approachTransition && <ClearanceField label={t('beyondAtcPanel.clearance.transition')} value={r.approachTransition} />}
        {r.altitudeFt !== undefined && (
          <ClearanceField
            label={t('beyondAtcPanel.clearance.altitude')}
            value={t('beyondAtcPanel.clearance.altitudeValue', { altitude: r.altitudeFt })}
          />
        )}
        {r.squawk && <ClearanceField label={t('beyondAtcPanel.clearance.squawk')} value={r.squawk} />}
        {r.nextFrequency && (
          <ClearanceField
            label={t('beyondAtcPanel.clearance.nextFrequency')}
            value={t('beyondAtcPanel.clearance.nextFrequencyValue', {
              station: r.nextFrequencyStation ?? '',
              frequency: r.nextFrequency
            })}
          />
        )}
      </div>
    </div>
  )
}

/** Always expanded (per flightdeck-backend's docs/plans/beyondatc-panel-redesign.md — kept
 *  as-is rather than collapsing), but scroll-anchored to the latest line: a real flight's
 *  transcript can run long, and without this the newest exchange is scrolled out of view
 *  behind the fixed `max-h-64` unless the pilot scrolls manually. */
function Transcript(props: { entries: BeyondAtcTranscriptEntry[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  const latestRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    latestRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.entries])

  if (props.entries.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('beyondAtcPanel.transcript')}</p>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
        {props.entries.map((entry, index) => (
          <li key={index} ref={index === props.entries.length - 1 ? latestRef : undefined} className="flex gap-1.5">
            <span className="shrink-0 font-medium text-foreground">{t(SPEAKER_KEY[entry.speaker])}:</span>
            <span className="text-muted-foreground">{entry.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * BeyondATC integration's live panel (Parts 1-2 of flightdeck-backend's docs/plans/
 * beyondatc-integration.md) — its own top-level tab, same shape as GsxRemotePanel: current-
 * value fetches on mount plus live subscriptions, so a panel mounting (or remounting) after
 * BeyondATC already pushed state doesn't show nothing until the next line arrives.
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
    <div className="flex flex-col gap-3">
      {status.state !== 'connected' && (
        <p className="text-xs text-muted-foreground">
          {status.state === 'connecting' ? t('beyondAtcPanel.connecting') : t('beyondAtcPanel.disconnected')}
        </p>
      )}
      <StatusCard state={state} />
      <ClearanceCard readout={clearanceReadout} />
      <BeyondAtcActionsPanel
        actions={state.actions}
        onSelectAction={(label) => window.winglog.beyondAtcSetAction(label)}
        com1Frequency={state.facility?.frequency ?? null}
        com2Frequency={state.com2?.frequency ?? null}
        onSetFrequency={(frequency) => window.winglog.beyondAtcSetFrequency(frequency)}
        onSetFrequencyCom2={(frequency) => window.winglog.beyondAtcSetFrequencyCom2(frequency)}
        frequencyOptions={state.frequencies}
        autoTune={state.autoTune}
        autoRespond={state.autoRespond}
        onSetAutoTune={(value) => window.winglog.beyondAtcSetAutoTune(value)}
        onSetAutoRespond={(value) => window.winglog.beyondAtcSetAutoRespond(value)}
      />
      <Transcript entries={transcript} />
    </div>
  )
}
