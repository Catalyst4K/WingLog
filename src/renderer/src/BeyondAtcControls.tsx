/** BeyondATC's controls: the action buttons and the radios with their frequency picker. */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Headset, Loader2 } from 'lucide-react'
import type {
  BeyondAtcCom2,
  BeyondAtcFacility,
  BeyondAtcFrequencyOption,
  BeyondAtcProgress,
  BeyondAtcStepClimbStatus
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { BeyondAtcHiddenNote } from './online/BeyondAtcHiddenNote'
import { useBeyondAtcHidden } from './live/use-online-status'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  groupFrequencies,
  normaliseFrequency,
  openingAirport,
  stationDisplayName,
  type AirportFrequencies as AirportFrequencyGroups
} from '@shared/beyondatc-frequencies'

/**
 * BeyondATC's own live "Actions" menu and the COM1/COM2 radios control (Part 2 of
 * winglog-backend's docs/plans/beyondatc-integration.md) — two separate exports, each its
 * own card in `BeyondAtcPanel`'s dispatch-style card grid
 * (winglog-backend's docs/plans/beyondatc-panel-redesign.md). Deliberately clean data/
 * action interfaces, per that plan's explicit instruction: this is what gets forwarded into
 * the LAN server (lan-web-viewer.md) once that's built, so neither depends on
 * `BeyondAtcPanel`'s own transcript/status state.
 *
 * AutoTune/AutoRespond live inside `BeyondAtcRadios`, not a separate block — Callum's own
 * call once the panel was actually split into cards: radios is where you'd look for them,
 * same as the frequencies themselves. Both commands and the frequency list are confirmed
 * working live (docs/beyondatc-notes.md).
 */
export interface BeyondAtcActionsProps {
  actions: string[]
  onSelectAction: (label: string) => void
  /** The action just pressed and not yet transmitted: shown busy so a press that BeyondATC
   *  queues behind other traffic doesn't look like nothing happened. */
  pendingLabel?: string | null
}

/**
 * The actions BeyondATC offers now, as buttons.
 *
 * @param props The actions BeyondATC offers, the select handler and the one in progress.
 * @returns The buttons, or null with no actions.
 */
export function BeyondAtcActions(props: BeyondAtcActionsProps): React.JSX.Element | null {
  if (props.actions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.actions.map((label) => {
        const pending = label === props.pendingLabel
        return (
          <Button
            key={label}
            type="button"
            variant={pending ? 'secondary' : 'outline'}
            size="sm"
            className="h-auto py-1.5 text-xs"
            aria-busy={pending || undefined}
            onClick={() => props.onSelectAction(label)}
          >
            {pending && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
            {label}
          </Button>
        )
      })}
    </div>
  )
}

/** BeyondATC's own `type` field, mapped to a clear translated heading: the station `name` alone isn't reliably clear about what a
 *  frequency is *for* (real captures: WSSS's delivery frequency is named just "SINGAPORE", its ATIS "WSSS"). BeyondATC's `Clearance`
 *  is shown as "Delivery", the term pilots use. An unrecognised type falls back to BeyondATC's own raw text. */
const FREQUENCY_TYPE_KEY: Record<string, string> = {
  Approach: 'beyondAtcPanel.frequencyType.approach',
  Departure: 'beyondAtcPanel.frequencyType.departure',
  Tower: 'beyondAtcPanel.frequencyType.tower',
  Ground: 'beyondAtcPanel.frequencyType.ground',
  Clearance: 'beyondAtcPanel.frequencyType.delivery',
  ATIS: 'beyondAtcPanel.frequencyType.atis',
  Center: 'beyondAtcPanel.frequencyType.center'
}

/**
 * One selectable station: its name, the runways it serves when known (BeyondATC's list carries none; they are learned from the station
 * once tuned), its frequency, and a mark on the one already tuned.
 *
 * @param props The station, whether it is the tuned one, and the select handler.
 * @returns The element.
 */
function FrequencyStationButton(props: {
  station: BeyondAtcFrequencyOption
  tuned: boolean
  onSelect: (frequency: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { station } = props
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-full justify-start gap-2 py-1.5 text-left text-xs whitespace-normal"
      aria-current={props.tuned || undefined}
      onClick={() => props.onSelect(station.frequency)}
    >
      <span className="min-w-0 flex-1">{stationDisplayName(station.name)}</span>{' '}
      {station.runways && (
        <>
          <Badge variant="outline" className="font-normal">
            {t('beyondAtcPanel.frequencyPicker.runways', { runways: station.runways })}
          </Badge>{' '}
        </>
      )}
      {props.tuned && (
        <>
          <Badge>{t('beyondAtcPanel.frequencyPicker.tuned')}</Badge>{' '}
        </>
      )}
      <span className="font-mono tabular-nums">{station.frequency}</span>
    </Button>
  )
}

/**
 * One airport's stations, a section per type in the order a flight uses them, or a note when BeyondATC listed nothing for it.
 *
 * @param props The airport's grouped frequencies (or undefined), the tuned frequency and the select handler.
 * @returns The element.
 */
function AirportFrequencies(props: {
  airport: AirportFrequencyGroups | undefined
  tunedFrequency: string | null
  onSelect: (frequency: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!props.airport || props.airport.groups.length === 0)
    return <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('beyondAtcPanel.noFrequencies')}</p>
  return (
    <div className="flex flex-col gap-2">
      {props.airport.groups.map((group) => {
        const typeKey = FREQUENCY_TYPE_KEY[group.type]
        return (
          <section key={group.type} aria-label={typeKey ? t(typeKey) : group.type}>
            <h3 className="px-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {typeKey ? t(typeKey) : group.type}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {group.stations.map((station) => (
                <li key={`${station.name}-${station.frequency}`}>
                  <FrequencyStationButton
                    station={station}
                    tuned={
                      props.tunedFrequency !== null &&
                      normaliseFrequency(station.frequency) === normaliseFrequency(props.tunedFrequency)
                    }
                    onSelect={props.onSelect}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/**
 * The frequency dialog: Departure and Arrival tabs (Callum's call), opened on the one the flight is at, each airport's
 * stations grouped by type with the en-route entries last. In a centered dialog since the list is long.
 *
 * @param props The frequencies, the flight's airports and progress, the tuned frequency and the select handler.
 * @returns The element.
 */
function FrequencyPicker(props: {
  departureAirport: string | null
  arrivalAirport: string | null
  progressPct: number | null
  tunedFrequency: string | null
  options: BeyondAtcFrequencyOption[]
  onSelect: (frequency: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const airports = useMemo(() => groupFrequencies(props.options), [props.options])

  if (props.options.length === 0) return null

  function select(frequency: string): void {
    props.onSelect(frequency)
    setOpen(false)
  }

  /**
   * One tab's content: the airport's stations, then the en-route ones every tab shares.
   *
   * @param icao The tab's airport.
   * @returns The element.
   */
  function tabContent(icao: string | null): React.JSX.Element {
    const airport = airports.find((a) => a.airport === icao)
    const enroute = airports.find((a) => a.airport === '')
    return (
      <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
        {airport?.airportName && (
          <p className="px-1.5 text-xs font-medium">{`${airport.airport} ${airport.airportName}`}</p>
        )}
        <AirportFrequencies airport={airport} tunedFrequency={props.tunedFrequency} onSelect={select} />
        {enroute && (
          <div className="flex flex-col gap-1">
            <p className="px-1.5 text-xs font-medium">{t('beyondAtcPanel.frequencyPicker.enroute')}</p>
            <AirportFrequencies airport={enroute} tunedFrequency={props.tunedFrequency} onSelect={select} />
          </div>
        )}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          // Same look as GsxRemotePanel's MenuHeader: primary-tinted outline and fill.
          className="h-7 gap-1 border-primary/40 bg-primary/5 px-2 text-xs text-foreground shadow-sm hover:bg-primary/10"
        >
          <Headset className="size-3.5 text-primary" aria-hidden />
          {t('beyondAtcPanel.frequenciesButton')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('beyondAtcPanel.selectFrequency')}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={openingAirport(props.progressPct)}>
          <TabsList className="w-full">
            <TabsTrigger value="departure">{t('beyondAtcPanel.departure')}</TabsTrigger>
            <TabsTrigger value="arrival">{t('beyondAtcPanel.arrival')}</TabsTrigger>
          </TabsList>
          <TabsContent value="departure">{tabContent(props.departureAirport)}</TabsContent>
          <TabsContent value="arrival">{tabContent(props.arrivalAirport)}</TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One frequency control: the tuned station's name, the frequency in a field that holds the tuned value (and can be edited and set),
 * and the dialog of known stations. Only a frequency the user is part-way through typing is held back from a change coming from
 * BeyondATC, until it is set or the field loses focus.
 *
 * @param props The label, the tuned station and frequency, the options and flight, and the setter.
 * @returns The row.
 */
function FrequencyRow(props: {
  label: string
  stationName: string | null
  frequency: string | null
  options: BeyondAtcFrequencyOption[]
  departureAirport: string | null
  arrivalAirport: string | null
  progressPct: number | null
  onSet: (frequency: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? props.frequency ?? ''

  function commit(): void {
    const trimmed = shown.trim()
    setDraft(null)
    if (trimmed === '' || trimmed === (props.frequency ?? '').trim()) return
    props.onSet(trimmed)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{props.label}</span>
        <span className="truncate text-muted-foreground">
          {props.stationName ?? t('beyondAtcPanel.frequencyUnknown')}
        </span>
      </div>
      {/* Moving between the field and this row's own buttons keeps what was typed; leaving the row abandons it. */}
      <div
        className="flex items-center gap-1.5"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDraft(null)
        }}
      >
        <FrequencyPicker
          options={props.options}
          departureAirport={props.departureAirport}
          arrivalAirport={props.arrivalAirport}
          progressPct={props.progressPct}
          tunedFrequency={props.frequency}
          onSelect={props.onSet}
        />
        <Input
          type="text"
          inputMode="decimal"
          aria-label={t('beyondAtcPanel.frequencyField', { radio: props.label })}
          placeholder={t('beyondAtcPanel.frequencyPlaceholder')}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          className="h-7 w-24 font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={commit}>
          {t('beyondAtcPanel.setFrequency')}
        </Button>
      </div>
    </div>
  )
}

function AutoToggle(props: {
  label: string
  value: boolean | null
  onSet: (value: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant={props.value ? 'default' : 'outline'}
      size="sm"
      className="h-auto py-1.5 text-xs"
      disabled={props.value === null}
      aria-pressed={props.value === true}
      onClick={() => props.onSet(!props.value)}
    >
      {props.label}:{' '}
      {props.value === null
        ? t('beyondAtcPanel.settings.unknown')
        : props.value
          ? t('beyondAtcPanel.settings.on')
          : t('beyondAtcPanel.settings.off')}
    </Button>
  )
}

export interface BeyondAtcRadiosProps {
  /** The station name + frequency currently tuned, not just the raw frequency digits — this
   *  is the "what you're tuned to" surface now, moved out of the top info card per Callum's
   * own call (redesign conversation). */
  facility: BeyondAtcFacility | null
  com2: BeyondAtcCom2 | null
  /** Drives the frequency picker's Departure/Arrival tab split — `from`/`to` are the same
   *  ICAO codes the real `Frequencies` entries' own `airport` field uses. */
  progress: BeyondAtcProgress | null
  onSetFrequency: (frequency: string) => void
  onSetFrequencyCom2: (frequency: string) => void
  /** BeyondATC's own real frequency list for the flight's airports (`frequencies`,
   *  requested automatically on connect) — lets a station be picked directly instead of
   *  typed blind. Manual entry stays available regardless, for anything not listed. */
  frequencyOptions: BeyondAtcFrequencyOption[]
  autoTune: boolean | null
  autoRespond: boolean | null
  onSetAutoTune: (value: boolean) => void
  onSetAutoRespond: (value: boolean) => void
  /** WingLog's own auto step climb — not a BeyondATC setting (winglog-backend's
   *  docs/plans/beyondatc-auto-step-climb.md). */
  stepClimb: BeyondAtcStepClimbStatus
  onSetStepClimb: (enabled: boolean) => void
}

function flightLevel(feet: number): string {
  return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`
}

/**
 * One line under the toggles: what auto step climb is doing — a request in progress, the
 * last result, an FCU level waiting on the climb, or the next planned step.
 *
 * @param props The step climb status.
 * @returns The line, or null with nothing to say.
 */
function StepClimbStatusLine(props: { status: BeyondAtcStepClimbStatus }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { status } = props
  if (!status.enabled) return null
  const lines: string[] = []
  if (status.pendingAltitudeFt !== null) {
    lines.push(t('beyondAtcPanel.stepClimb.pending', { level: flightLevel(status.pendingAltitudeFt) }))
  } else if (status.last) {
    const outcome = t(`beyondAtcPanel.stepClimb.outcome.${status.last.outcome}`)
    lines.push(
      status.last.dropped
        ? t('beyondAtcPanel.stepClimb.dropped', { level: flightLevel(status.last.altitudeFt), outcome })
        : t('beyondAtcPanel.stepClimb.last', { level: flightLevel(status.last.altitudeFt), outcome })
    )
  }
  if (status.waitingForClimbFt !== null) {
    lines.push(
      t('beyondAtcPanel.stepClimb.waitingForClimb', { level: flightLevel(status.waitingForClimbFt) })
    )
  }
  if (status.pastTopOfDescent) {
    lines.push(t('beyondAtcPanel.stepClimb.pastTopOfDescent'))
  } else if (status.nextStep) {
    lines.push(
      t('beyondAtcPanel.stepClimb.next', {
        level: flightLevel(status.nextStep.altitudeFt),
        fix: status.nextStep.ident,
        distance: status.nextStep.distanceNm
      })
    )
  }
  if (lines.length === 0) lines.push(t('beyondAtcPanel.stepClimb.watching'))
  return (
    <div className="flex flex-col text-xs text-muted-foreground">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  )
}

/**
 * COM1 and COM2 with the frequency picker, or the note that the network's controllers give the frequencies while the pilot is online.
 *
 * @param props What is tuned and the frequencies on offer.
 * @returns The element.
 */
function FrequencyRows(props: BeyondAtcRadiosProps): React.JSX.Element {
  // Online, the network's controllers give the frequencies: BeyondATC's suggestions are not offered.
  return useBeyondAtcHidden() ? <BeyondAtcHiddenNote /> : <FrequencyRowPair {...props} />
}

/**
 * COM1 and COM2 with the frequency picker.
 *
 * @param props What is tuned and the frequencies on offer.
 * @returns The element.
 */
function FrequencyRowPair(props: BeyondAtcRadiosProps): React.JSX.Element {
  const departureAirport = props.progress?.from ?? null
  const arrivalAirport = props.progress?.to ?? null
  const progressPct = props.progress?.pct ?? null
  return (
    <>
      <div className="flex flex-col gap-2">
        <FrequencyRow
          label="COM1"
          stationName={props.facility?.name ?? null}
          frequency={props.facility?.frequency ?? null}
          options={props.frequencyOptions}
          departureAirport={departureAirport}
          arrivalAirport={arrivalAirport}
          progressPct={progressPct}
          onSet={props.onSetFrequency}
        />
        {/* A switched-off COM2 comes through as {"label":"Radio Off","frequency":""}: the label alone, and an empty field. */}
        <FrequencyRow
          label="COM2"
          stationName={props.com2?.label ?? null}
          frequency={props.com2?.frequency || null}
          options={props.frequencyOptions}
          departureAirport={departureAirport}
          arrivalAirport={arrivalAirport}
          progressPct={progressPct}
          onSet={props.onSetFrequencyCom2}
        />
      </div>
    </>
  )
}

/**
 * COM1 and COM2, the frequency picker, and the auto tune, respond and step climb toggles.
 *
 * @param props What is tuned, the frequencies on offer, the toggles and their handlers.
 * @returns The element.
 */
export function BeyondAtcRadios(props: BeyondAtcRadiosProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3">
      <FrequencyRows {...props} />
      <div className="flex flex-wrap gap-1.5">
        <AutoToggle
          label={t('beyondAtcPanel.settings.autoTune')}
          value={props.autoTune}
          onSet={props.onSetAutoTune}
        />
        <AutoToggle
          label={t('beyondAtcPanel.settings.autoRespond')}
          value={props.autoRespond}
          onSet={props.onSetAutoRespond}
        />
        <AutoToggle
          label={t('beyondAtcPanel.settings.stepClimb')}
          value={props.stepClimb.enabled}
          onSet={props.onSetStepClimb}
        />
      </div>
      <StepClimbStatusLine status={props.stepClimb} />
    </div>
  )
}
