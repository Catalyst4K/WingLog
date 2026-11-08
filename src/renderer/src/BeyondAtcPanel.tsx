/** The BeyondATC tab's panel: station info, the latest instruction, actions, radios and transcript. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  BeyondAtcArrivalClearance,
  BeyondAtcCommsState,
  BeyondAtcConnectionStatus,
  BeyondAtcSettings,
  BeyondAtcState,
  BeyondAtcStepClimbStatus,
  BeyondAtcTranscriptEntry,
  ProcedureSelection
} from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { AirlineLogo } from './AirlineLogo'
import { useFlightAirlineIata } from './use-flight-airline'
import { BeyondAtcAtisButton } from './BeyondAtcAtis'
import { BeyondAtcActions, BeyondAtcRadios } from './BeyondAtcControls'
import { AtcClearanceBackupLine } from './app/AtcClearanceBackup'
import { latestAtcInstruction, type AtcInstruction, type InstructionFieldKey } from './beyond-atc-instruction'
import { useLiveClient, useLiveTopic } from './live/LiveClient'
import { Badge } from '@/components/ui/badge'
import { StatusLight } from '@/components/StatusLight'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { asyncHandler, runAsync } from './report-error'

const STEP_CLIMB_OFF: BeyondAtcStepClimbStatus = {
  enabled: false,
  nextStep: null,
  pendingAltitudeFt: null,
  waitingForClimbFt: null,
  pastTopOfDescent: false,
  last: null
}

const SPEAKER_KEY: Record<BeyondAtcTranscriptEntry['speaker'], string> = {
  player: 'beyondAtcPanel.speaker.player',
  atc: 'beyondAtcPanel.speaker.atc',
  traffic: 'beyondAtcPanel.speaker.traffic',
  atcTraffic: 'beyondAtcPanel.speaker.atcTraffic'
}

/** A panel of the page (the canvas's r3-beyondatc): the card colour, a 6 px corner, 20 px inside. */
const PANEL = 'rounded-b-md [--card-spacing:--spacing(5)]'
/** A panel's title. */
const PANEL_TITLE = 'text-[17px] leading-snug font-bold tracking-[-0.01em]'

function InfoField(props: { label: string; value: string; plan?: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex flex-col">
      <span className="text-[13px] text-muted-foreground">{props.label}</span>
      <span className="font-mono text-lg whitespace-nowrap text-foreground">
        {props.value}
        {props.plan}
      </span>
    </span>
  )
}

/** The plan's choice for the instruction fields that name a procedure. */
const PLAN_FIELDS: Partial<Record<InstructionFieldKey, keyof ProcedureSelection>> = {
  sid: 'sidIdent',
  star: 'starIdent',
  approach: 'approachIdent'
}

/**
 * What the pilot's plan says beside what ATC cleared (winglog-backend docs/plans/v2-design.md, "BeyondATC"): the plan is magenta. The
 * same as the plan needs no note (it is what was expected); a different one shows the plan's.
 *
 * @param key The instruction field.
 * @param cleared What ATC cleared.
 * @param selection The procedures the pilot chose for the flight, or null when none are.
 * @returns The note, or nothing when the plan has no choice for this field or ATC cleared the same.
 */
function planNote(
  key: InstructionFieldKey,
  cleared: string,
  selection: ProcedureSelection | null
): React.ReactNode {
  const field = PLAN_FIELDS[key]
  const planned = field && selection ? selection[field] : null
  if (typeof planned !== 'string' || planned === '') return null
  if (cleared.trim().toUpperCase() === planned.trim().toUpperCase()) return null
  return <span className="ml-2 font-mono text-[13px] text-muted-foreground">{`plan ${planned}`}</span>
}

/**
 * The top info strip (winglog-backend's docs/plans/beyondatc-panel-redesign.md): who you are and how far along the
 * flight is, inline in one compact card. ATC's own instructions are in `LatestInstructionCard` below it, and the "tuned
 * to" facility/COM2 info is `BeyondAtcRadios`' job. Always visible, like every other card here: a placeholder rather
 * than shifting the layout.
 *
 * @param props BeyondATC's state.
 * @returns The element.
 */
function InfoCard(props: { state: BeyondAtcState; statusLine: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const { callsign, progress } = props.state
  const iata = useFlightAirlineIata()
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        {!callsign && !progress && (
          <span className="text-sm text-muted-foreground">{t('beyondAtcPanel.noStatus')}</span>
        )}
        {callsign && (
          <span className="flex items-center gap-3">
            <AirlineLogo iata={iata} size={30} />
            <h2 className="m-0 font-display text-[32px] leading-[1.1] font-bold tracking-[-0.02em] text-foreground">
              {callsign.full}
            </h2>
          </span>
        )}
        {progress && (
          <span className="font-mono text-muted-foreground">
            {t('beyondAtcPanel.progress', { from: progress.from, to: progress.to, pct: progress.pct })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {props.statusLine}
        <BeyondAtcAtisButton />
      </div>
    </div>
  )
}

/**
 * The key facts from whatever ATC said last (clearance, taxi, handoff, climb/descent, takeoff…; beyond-atc-instruction.ts)
 * as labelled fields, with the full text underneath so nothing an unrecognised phrasing carries is hidden. The station
 * ATC spoke as sits in the header; clearances and permissions (cleared for takeoff, line up and wait…) stand out as
 * badges.
 *
 * The header's right side also keeps ATC's arrival clearance from the moment it's given until touchdown (kept in main by
 * ArrivalClearanceTracker): STAR and runway, switching to approach and transition once those come. It sits beside the
 * latest instruction, never in place of it.
 *
 * @param props The latest instruction and the arrival clearance, if any.
 * @returns The element.
 */
function InstructionFields(props: { instruction: AtcInstruction }): React.JSX.Element | null {
  const { t } = useTranslation()
  // The procedures the pilot chose, shown beside what ATC cleared.
  const plan = useLiveTopic('plannedRoute', null)?.selection ?? null
  const { instruction } = props
  const fields = instruction.fields.filter((f) => f.key !== 'station')
  if (instruction.actions.length === 0 && fields.length === 0) return null
  return (
    <div className="flex flex-wrap items-end gap-x-9 gap-y-3">
      {instruction.actions.map((action) => (
        <Badge key={action} variant="secondary">
          {t(`beyondAtcPanel.instruction.action.${action}`)}
        </Badge>
      ))}
      {fields.map((f) => (
        <InfoField
          key={f.key}
          label={t(`beyondAtcPanel.instruction.field.${f.key}`)}
          value={f.value}
          plan={planNote(f.key, f.value, plan)}
        />
      ))}
    </div>
  )
}

function LatestInstructionCard(props: {
  instruction: AtcInstruction | null
  arrival: BeyondAtcArrivalClearance | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const instruction = props.instruction
  const arrival = props.arrival
  const station = instruction?.fields.find((f) => f.key === 'station')?.value
  return (
    <Card className={PANEL}>
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-2">
        <CardTitle className={PANEL_TITLE}>{t('beyondAtcPanel.instruction.title')}</CardTitle>
        <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-1">
          {arrival?.approachIdent ? (
            <span data-testid="arrival-clearance" className="flex flex-wrap gap-x-4 gap-y-1">
              <InfoField
                label={t('beyondAtcPanel.instruction.field.approach')}
                value={arrival.approachIdent}
              />
              {arrival.approachTransition && (
                <InfoField
                  label={t('beyondAtcPanel.instruction.field.transition')}
                  value={arrival.approachTransition}
                />
              )}
            </span>
          ) : (
            arrival?.starIdent && (
              <span data-testid="arrival-clearance" className="flex flex-wrap gap-x-4 gap-y-1">
                <InfoField label={t('beyondAtcPanel.instruction.field.star')} value={arrival.starIdent} />
                {arrival.runway && (
                  <InfoField label={t('beyondAtcPanel.instruction.field.runway')} value={arrival.runway} />
                )}
              </span>
            )
          )}
          {station && <span className="text-sm text-muted-foreground">{station}</span>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!instruction ? (
          <p className="text-sm text-muted-foreground">{t('beyondAtcPanel.instruction.none')}</p>
        ) : (
          <>
            <InstructionFields instruction={instruction} />
            <p className="m-0 text-sm leading-normal text-muted-foreground">{instruction.text}</p>
          </>
        )}
        <AtcClearanceBackupLine />
      </CardContent>
    </Card>
  )
}

/** How long a pressed action stays marked as pending if BeyondATC never reports it going
 *  out — a safety net so a missed state can't leave a spinner up for good. */
export const PENDING_ACTION_TIMEOUT_MS = 60_000

/**
 * What the frequency is doing, from BeyondATC's CommsState, for the line above the
 * buttons. Null when there's nothing worth saying.
 *
 * @param t The translation function.
 * @param pendingLabel The action just pressed, or null.
 * @param comms BeyondATC's comms state, or null.
 * @returns The status line for the actions card.
 */
function commsLine(
  t: (key: string, options?: Record<string, string>) => string,
  pendingLabel: string | null,
  comms: BeyondAtcCommsState | null
): string | null {
  if (comms?.mode === 'speaking') return t('beyondAtcPanel.comms.transmitting')
  if (comms?.mode === 'awaiting') return t('beyondAtcPanel.comms.awaitingReply')
  if (pendingLabel) return t('beyondAtcPanel.comms.queuedAction', { action: pendingLabel })
  if (comms?.mode === 'queued' || comms?.mode === 'traffic') return t('beyondAtcPanel.comms.queued')
  return null
}

/**
 * Always visible, like every other card on this page — a placeholder rather than
 * disappearing entirely while disconnected or when BeyondATC has no menu currently
 * offered.
 *
 * @param props The actions, the select handler, the one in progress and the comms state.
 * @returns The element.
 */
function ActionsCard(props: {
  actions: string[]
  onSelectAction: (label: string) => void
  pendingLabel: string | null
  commsState: BeyondAtcCommsState | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const line = commsLine(t, props.pendingLabel, props.commsState)
  return (
    <Card className={PANEL}>
      <CardHeader>
        <CardTitle className={PANEL_TITLE}>{t('beyondAtcPanel.actions')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {line}
        </p>
        {props.actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.noActions')}</p>
        ) : (
          <BeyondAtcActions
            actions={props.actions}
            onSelectAction={props.onSelectAction}
            pendingLabel={props.pendingLabel}
          />
        )}
      </CardContent>
    </Card>
  )
}

function RadiosCard(props: React.ComponentProps<typeof BeyondAtcRadios>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className={PANEL}>
      <CardHeader>
        <CardTitle className={PANEL_TITLE}>{t('beyondAtcPanel.radios')}</CardTitle>
      </CardHeader>
      <CardContent>
        <BeyondAtcRadios {...props} />
      </CardContent>
    </Card>
  )
}

/**
 * The radios as a thin strip across the page between the instruction and the actions, so they stay on screen however tall the cards below
 * them grow: COM1 and COM2 side by side, the three switches in a line under them. The strip has no title, as COM1 and COM2 say what it is.
 *
 * @param props The radios' props.
 * @returns The element.
 */
function RadiosStrip(props: React.ComponentProps<typeof BeyondAtcRadios>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card
      role="group"
      aria-label={t('beyondAtcPanel.radios')}
      className="rounded-b-md [--card-spacing:--spacing(3)]"
    >
      <CardContent className="px-5">
        <BeyondAtcRadios {...props} strip />
      </CardContent>
    </Card>
  )
}

/** How close to the bottom of the transcript counts as "at the bottom" (a line is about 16 px). */
const FOLLOW_SLACK_PX = 24

/**
 * Always visible, like `ActionsCard`'s Radios sibling: an empty scrollable box rather than disappearing, so the right
 * column doesn't jump around as the panel connects (beyondatc-panel-redesign.md). It fills the bounded height
 * `BeyondAtcView`/`BeyondAtcPanel` propagate down from the window (`h-full` on `BeyondAtcView`'s root, `flex-1` below it,
 * `min-h-0`/`flex-1` at every level down to the `<ul>`), and its list scrolls internally.
 *
 * **The parent row must be CSS Grid, not a flex row.** With `flex flex-wrap items-stretch`, `align-items: stretch` did
 * not reliably give this column a definite height for its `min-h-0` descendants, so the list rendered at its full height
 * and the whole *page* scrolled to follow the newest line (via `scrollIntoView` below), pushing the other cards off
 * screen. Grid resolves a definite height for every cell in a row before laying out its contents. The list stays
 * always-expanded and follows the newest line while the reader is at the bottom of it, but only by moving the list's own
 * scroll position: never the page (`scrollIntoView` scrolled every ancestor, so on a phone each new instruction threw the
 * whole page to the bottom), and not at all once the reader has scrolled up to read.
 *
 * @param props The transcript.
 * @returns The element.
 */
function TranscriptCard(props: { entries: BeyondAtcTranscriptEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLUListElement>(null)
  const following = useRef(true)

  useEffect(() => {
    const list = listRef.current
    if (list && following.current) list.scrollTop = list.scrollHeight
  }, [props.entries])

  return (
    <Card className={`${PANEL} min-h-0 flex-1`}>
      <CardHeader>
        <CardTitle className={PANEL_TITLE}>{t('beyondAtcPanel.transcript')}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <ul
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget
            following.current = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX
          }}
          className="m-0 flex h-full min-h-0 list-none flex-col overflow-y-auto p-0 text-sm"
        >
          {props.entries.map((entry, index) => (
            <li key={index} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 border-b border-border py-2">
              <span className="pt-px text-[13px] font-semibold text-muted-foreground">
                {t(SPEAKER_KEY[entry.speaker])}
              </span>
              <span
                className={`leading-normal ${entry.speaker === 'player' ? 'text-muted-foreground' : 'text-foreground'}`}
              >
                {entry.text}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/**
 * The phone layout: one column that scrolls with the page, the radios in their panel, and the transcript at a fixed height at the end.
 *
 * @param props Each card's props, and the connection line.
 * @returns The element.
 */
function CompactLayout(props: {
  statusLine: React.ReactNode
  state: BeyondAtcState
  instruction: AtcInstruction | null
  arrival: BeyondAtcArrivalClearance | null
  actions: React.ComponentProps<typeof ActionsCard>
  radios: React.ComponentProps<typeof BeyondAtcRadios>
  transcript: BeyondAtcTranscriptEntry[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <InfoCard state={props.state} statusLine={props.statusLine} />
      <LatestInstructionCard instruction={props.instruction} arrival={props.arrival} />
      <ActionsCard {...props.actions} />
      <RadiosCard {...props.radios} compact />
      <div className="flex h-80 flex-col">
        <TranscriptCard entries={props.transcript} />
      </div>
    </div>
  )
}

/**
 * BeyondATC integration's live panel (Parts 1-2 of winglog-backend's docs/plans/beyondatc-integration.md), its own
 * top-level tab, same shape as GsxRemotePanel: current-value fetches on mount plus live subscriptions, so a panel
 * mounting after BeyondATC already pushed state doesn't show nothing until the next line arrives.
 *
 * Card-grid layout (beyondatc-panel-redesign.md): a compact info strip on top, the instruction, a thin Radios strip, then two
 * columns: Actions on the left (its own natural height, `self-start`), a Transcript on the right that matches that height with its own
 * internal scroll. The row is CSS Grid, not flexbox (see `TranscriptCard`), and `BeyondAtcView`'s `h-full` root gives the
 * area a window-bounded height to work with.
 */
const DISCONNECTED: BeyondAtcConnectionStatus = { state: 'disconnected', lastError: null }
const NO_TRANSCRIPT: BeyondAtcTranscriptEntry[] = []

/**
 * The BeyondATC panel, live from BeyondATC's state and transcript.
 *
 * @param props `compact` for a phone: one column that scrolls with the page, with the radios behind a button.
 * @returns The element.
 */
export function BeyondAtcPanel(props: { compact?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<BeyondAtcSettings | null>(null)
  // Live state and commands through the LiveClient (live-data-seam.md, part C).
  const live = useLiveClient()
  const status = useLiveTopic('beyondAtcStatus', DISCONNECTED)
  const [state, setState] = useState<BeyondAtcState>(EMPTY_BEYONDATC_STATE)
  const transcript = useLiveTopic('beyondAtcTranscript', NO_TRANSCRIPT)
  const stepClimb = useLiveTopic('beyondAtcStepClimb', STEP_CLIMB_OFF)
  const arrival = useLiveTopic('beyondAtcArrival', null)
  const latestInstruction = useMemo(() => latestAtcInstruction(transcript, state), [transcript, state])
  // The action just pressed, until BeyondATC transmits it: a press queued behind other traffic looked like it did nothing.
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearPendingAction(): void {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = null
    setPendingAction(null)
  }

  function selectAction(label: string): void {
    runAsync('BeyondAtcPanel live.command', live.command('atc.setAction', label))
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(clearPendingAction, PENDING_ACTION_TIMEOUT_MS)
    setPendingAction(label)
  }

  useEffect(() => {
    runAsync('BeyondAtcPanel settingsGetBeyondAtc', winglogApi().settingsGetBeyondAtc().then(setSettings))
    runAsync(
      'BeyondAtcPanel live.get',
      live.get('beyondAtcState').then((current) => {
        if (current) setState(current)
      })
    )
    const unsubscribeState = live.subscribe('beyondAtcState', (next) => {
      setState(next)
      // Our call is going out: it's no longer waiting.
      if (next.commsState?.mode === 'speaking') clearPendingAction()
    })
    return () => {
      unsubscribeState()
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    }
  }, [live])

  if (settings === null) return <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.loading')}</p>

  if (!settings.enabled) {
    return <p className="text-xs text-muted-foreground">{t('beyondAtcPanel.notConfigured')}</p>
  }

  const statusLine = (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <StatusLight state={status.state === 'connected' ? 'green' : 'amber'} />
      {status.state === 'connected'
        ? t('beyondAtcPanel.connected')
        : status.state === 'connecting'
          ? t('beyondAtcPanel.connecting')
          : t('beyondAtcPanel.disconnected')}
    </span>
  )
  const actionsProps = {
    actions: state.actions,
    onSelectAction: selectAction,
    pendingLabel: pendingAction,
    commsState: state.commsState
  }
  const radiosProps = {
    facility: state.facility,
    com2: state.com2,
    progress: state.progress,
    onSetFrequency: asyncHandler('BeyondAtcPanel atc.setFrequency', (frequency: string) =>
      live.command('atc.setFrequency', frequency)
    ),
    onSetFrequencyCom2: asyncHandler('BeyondAtcPanel atc.setFrequencyCom2', (frequency: string) =>
      live.command('atc.setFrequencyCom2', frequency)
    ),
    frequencyOptions: state.frequencies,
    autoTune: state.autoTune,
    autoRespond: state.autoRespond,
    onSetAutoTune: asyncHandler('BeyondAtcPanel atc.setAutoTune', (value: boolean) =>
      live.command('atc.setAutoTune', value)
    ),
    onSetAutoRespond: asyncHandler('BeyondAtcPanel atc.setAutoRespond', (value: boolean) =>
      live.command('atc.setAutoRespond', value)
    ),
    stepClimb,
    onSetStepClimb: asyncHandler('BeyondAtcPanel atc.setStepClimb', (enabled: boolean) =>
      live.command('atc.setStepClimb', enabled)
    )
  }

  if (props.compact) {
    return (
      <CompactLayout
        statusLine={statusLine}
        state={state}
        instruction={latestInstruction}
        arrival={arrival}
        actions={actionsProps}
        radios={radiosProps}
        transcript={transcript}
      />
    )
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-5">
      {/* The connection sits in the header, shown while connected too, so an idle session still confirms the link is live (real gap found live). */}
      <InfoCard state={state} statusLine={statusLine} />
      <LatestInstructionCard instruction={latestInstruction} arrival={arrival} />
      <RadiosStrip {...radiosProps} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 @3xl:grid-cols-[minmax(18rem,28rem)_minmax(18rem,1fr)]">
        <div className="flex min-h-0 flex-col gap-4 self-start">
          <ActionsCard {...actionsProps} />
        </div>
        <div className="flex min-h-0 flex-col gap-4">
          <TranscriptCard entries={transcript} />
        </div>
      </div>
    </div>
  )
}
