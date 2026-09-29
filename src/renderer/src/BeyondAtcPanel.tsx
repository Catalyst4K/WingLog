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

function InfoField(props: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="text-muted-foreground">{props.label}: </span>
      <span className="font-medium text-foreground">{props.value}</span>
    </span>
  )
}

/** The top info strip (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md) —
 *  callsign/progress/comms-mode plus the boxed clearance readout, shrunk to one compact
 *  card with every field inline (a wrapped row), not stacked one-per-line. Deliberately
 *  doesn't show "tuned to" facility/COM2 info — that's `BeyondAtcRadios`' job now, per
 *  Callum's own call once the panel was actually split into cards. Hidden entirely when
 *  there's nothing at all to show. */
function InfoCard(props: { state: BeyondAtcState; readout: ClearanceReadout }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { callsign, progress, commsState } = props.state
  const r = props.readout
  if (!callsign && !progress && !commsState && Object.keys(r).length === 0) return null
  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {callsign && <span className="text-sm font-semibold text-foreground">{callsign.full}</span>}
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

function ActionsCard(props: { actions: string[]; onSelectAction: (label: string) => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.actions.length === 0) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('beyondAtcPanel.actions')}</CardTitle>
      </CardHeader>
      <CardContent>
        <BeyondAtcActions actions={props.actions} onSelectAction={props.onSelectAction} />
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
 *  (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md). Always expanded (kept
 *  as-is rather than collapsing), but scroll-anchored to the latest line: a real flight's
 *  transcript can run long, and without this the newest exchange is scrolled out of view
 *  unless the pilot scrolls manually. Its own card, right column, dispatch-style layout. */
function TranscriptCard(props: { entries: BeyondAtcTranscriptEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  const latestRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    latestRef.current?.scrollIntoView({ block: 'nearest' })
  }, [props.entries])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('beyondAtcPanel.transcript')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto text-xs">
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
 * design pass, 2026-09-29): a compact info strip on top, then a dispatch-style two-column
 * area below — Actions + Radios on the left, a scrollable Transcript on the right — mirroring
 * `DispatchView`'s own `flex flex-wrap items-start gap-4` / `min-w-72 max-w-md flex-1` +
 * `min-w-72 flex-1` column convention, not a new layout invented from scratch.
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
    <div className="flex flex-col gap-4">
      {status.state !== 'connected' && (
        <p className="text-xs text-muted-foreground">
          {status.state === 'connecting' ? t('beyondAtcPanel.connecting') : t('beyondAtcPanel.disconnected')}
        </p>
      )}
      <InfoCard state={state} readout={clearanceReadout} />
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-72 max-w-md flex-1 flex-col gap-4">
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
        <div className="flex min-w-72 flex-1 flex-col gap-4">
          <TranscriptCard entries={transcript} />
        </div>
      </div>
    </div>
  )
}
