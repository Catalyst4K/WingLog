import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcConnectionStatus, BeyondAtcSettings, BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { BeyondAtcActionsPanel } from './BeyondAtcActionsPanel'

const EMPTY_STATE: BeyondAtcState = {
  facility: null,
  com2: null,
  callsign: null,
  commsState: null,
  progress: null,
  actions: []
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

/** The live "who's talking/awaiting" indicator, same idea as GSX Remote's own status badge —
 *  drives off `CommsState.mode`, confirmed live via a real Radio Check trace
 *  (docs/beyondatc-notes.md). `text` is BeyondATC's own text (e.g. "Radio Check"), shown
 *  verbatim alongside the translated mode label, same "third-party text, not translated"
 *  precedent GsxRemotePanel already sets for GSX's own menu labels. */
function CommsIndicator(props: { commsState: BeyondAtcState['commsState'] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!props.commsState) return null
  return (
    <p className="text-xs text-muted-foreground">
      {t(COMMS_MODE_KEY[props.commsState.mode])}
      {props.commsState.text ? ` — ${props.commsState.text}` : ''}
    </p>
  )
}

function StateHeader(props: { state: BeyondAtcState }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { facility, callsign, progress } = props.state
  if (!facility && !callsign && !progress) return null
  return (
    <div className="flex flex-col gap-1">
      {callsign && <span className="text-sm font-medium text-foreground">{callsign.full}</span>}
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
    </div>
  )
}

function Transcript(props: { entries: BeyondAtcTranscriptEntry[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.entries.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium text-foreground">{t('beyondAtcPanel.transcript')}</p>
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
        {props.entries.map((entry, index) => (
          <li key={index} className="flex gap-1.5">
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
      <StateHeader state={state} />
      <CommsIndicator commsState={state.commsState} />
      <BeyondAtcActionsPanel
        actions={state.actions}
        onSelectAction={(label) => window.winglog.beyondAtcSetAction(label)}
        com1Frequency={state.facility?.frequency ?? null}
        com2Frequency={state.com2?.frequency ?? null}
        onSetFrequency={(frequency) => window.winglog.beyondAtcSetFrequency(frequency)}
        onSetFrequencyCom2={(frequency) => window.winglog.beyondAtcSetFrequencyCom2(frequency)}
      />
      <Transcript entries={transcript} />
    </div>
  )
}
