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
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

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
 * working live, 2026-09-29 (docs/beyondatc-notes.md).
 */
export interface BeyondAtcActionsProps {
  actions: string[]
  onSelectAction: (label: string) => void
  /** The action just pressed and not yet transmitted: shown busy so a press that BeyondATC
   *  queues behind other traffic doesn't look like nothing happened. */
  pendingLabel?: string | null
}

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

/** Splits the flat real frequency list into departure/arrival, by matching each option's
 *  `airport` (an ICAO code) against `Progress.from`/`to` — real captures only ever had the
 *  two flight-plan airports plus one enroute Center entry with no `airport` at all. That
 *  enroute entry doesn't belong to either phase specifically, so it's included in both
 *  tabs rather than dropped or given a third tab nobody asked for. */
function splitFrequencyOptions(
  options: BeyondAtcFrequencyOption[],
  departureAirport: string | null,
  arrivalAirport: string | null
): { departure: BeyondAtcFrequencyOption[]; arrival: BeyondAtcFrequencyOption[] } {
  const enroute = options.filter((o) => !o.airport)
  const departure = [...options.filter((o) => o.airport === departureAirport), ...enroute]
  const arrival = [...options.filter((o) => o.airport === arrivalAirport), ...enroute]
  return { departure, arrival }
}

/** BeyondATC's own `type` field, mapped to a clear translated label — the station `name`
 *  field alone isn't reliably clear about what a frequency is *for*: real captures showed
 *  WSSS's own clearance/delivery frequency named just "SINGAPORE" (no "Delivery" anywhere)
 *  and its ATIS frequencies named just "WSSS" (the bare airport code, no "ATIS"), while
 *  ZSPD's delivery frequency happened to already say "PUDONG DELIVERY". Leading every
 *  button with the real category, not trusting `name` to say it, is what actually makes
 *  Delivery/ATIS/etc. unambiguous regardless of how BeyondATC happened to name that one
 *  station (Callum's own call, 2026-09-29). BeyondATC's own `Clearance` type is shown as
 *  "Delivery" — the term pilots actually use for that frequency. An unrecognised type falls
 *  back to BeyondATC's own raw text rather than guessing a translation for it. */
const FREQUENCY_TYPE_KEY: Record<string, string> = {
  Approach: 'beyondAtcPanel.frequencyType.approach',
  Departure: 'beyondAtcPanel.frequencyType.departure',
  Tower: 'beyondAtcPanel.frequencyType.tower',
  Ground: 'beyondAtcPanel.frequencyType.ground',
  Clearance: 'beyondAtcPanel.frequencyType.delivery',
  ATIS: 'beyondAtcPanel.frequencyType.atis',
  Center: 'beyondAtcPanel.frequencyType.center'
}

/** One selectable station. Real captures showed BeyondATC supplying several distinct
 *  Approach frequencies for the same airport, one per runway, so the runway (when present)
 *  is shown next to the frequency it actually applies to, not just the station name. */
function FrequencyOptionButton(props: { station: BeyondAtcFrequencyOption; onSelect: (frequency: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const typeKey = FREQUENCY_TYPE_KEY[props.station.type]
  const typeLabel = typeKey ? t(typeKey) : props.station.type
  const label = props.station.runways
    ? t('beyondAtcPanel.frequencyOptionRunway', {
        type: typeLabel,
        station: props.station.name,
        frequency: props.station.frequency,
        runway: props.station.runways
      })
    : t('beyondAtcPanel.frequencyOption', { type: typeLabel, station: props.station.name, frequency: props.station.frequency })
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-full justify-start py-1.5 text-left text-xs whitespace-normal"
      onClick={() => props.onSelect(props.station.frequency)}
    >
      {label}
    </Button>
  )
}

function FrequencyOptionList(props: { stations: BeyondAtcFrequencyOption[]; onSelect: (frequency: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  if (props.stations.length === 0) return <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('beyondAtcPanel.noFrequencies')}</p>
  return (
    <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
      {props.stations.map((station) => (
        <li key={`${station.name}-${station.frequency}`}>
          <FrequencyOptionButton station={station} onSelect={props.onSelect} />
        </li>
      ))}
    </ul>
  )
}

/** Departure/arrival tabs (Callum's own call, 2026-09-29 — a single grouped-by-airport list
 *  read as one long list once a real flight plan filled it with every real station at both
 *  airports), in a centered dialog rather than a small anchored dropdown — Callum's own
 *  follow-up call, same evening, once the popover version turned out cramped for a list this
 *  long. Tabs need button/tabpanel semantics a listbox (`Select`) doesn't offer, which is
 *  why this was never a native `<select>`-style control to begin with. */
function FrequencyPicker(props: {
  departureAirport: string | null
  arrivalAirport: string | null
  options: BeyondAtcFrequencyOption[]
  onSelect: (frequency: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { departure, arrival } = useMemo(
    () => splitFrequencyOptions(props.options, props.departureAirport, props.arrivalAirport),
    [props.options, props.departureAirport, props.arrivalAirport]
  )

  if (props.options.length === 0) return null

  function select(frequency: string): void {
    props.onSelect(frequency)
    setOpen(false)
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
        <Tabs defaultValue="departure">
          <TabsList className="w-full">
            <TabsTrigger value="departure">{t('beyondAtcPanel.departure')}</TabsTrigger>
            <TabsTrigger value="arrival">{t('beyondAtcPanel.arrival')}</TabsTrigger>
          </TabsList>
          <TabsContent value="departure">
            <FrequencyOptionList stations={departure} onSelect={select} />
          </TabsContent>
          <TabsContent value="arrival">
            <FrequencyOptionList stations={arrival} onSelect={select} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function FrequencyRow(props: {
  label: string
  current: string | null
  options: BeyondAtcFrequencyOption[]
  departureAirport: string | null
  arrivalAirport: string | null
  onSet: (frequency: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  function commit(): void {
    const trimmed = value.trim()
    if (trimmed === '') return
    props.onSet(trimmed)
    setValue('')
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">{props.label}</span>
        <span className="truncate text-muted-foreground">{props.current ?? t('beyondAtcPanel.frequencyUnknown')}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <FrequencyPicker
          options={props.options}
          departureAirport={props.departureAirport}
          arrivalAirport={props.arrivalAirport}
          onSelect={props.onSet}
        />
        <Input
          type="text"
          inputMode="decimal"
          placeholder={t('beyondAtcPanel.frequencyPlaceholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
          className="h-7 w-24 text-xs"
        />
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={commit}>
          {t('beyondAtcPanel.setFrequency')}
        </Button>
      </div>
    </div>
  )
}

function AutoToggle(props: { label: string; value: boolean | null; onSet: (value: boolean) => void }): React.JSX.Element {
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
      {props.label}: {props.value === null ? t('beyondAtcPanel.settings.unknown') : props.value ? t('beyondAtcPanel.settings.on') : t('beyondAtcPanel.settings.off')}
    </Button>
  )
}

export interface BeyondAtcRadiosProps {
  /** The station name + frequency currently tuned, not just the raw frequency digits — this
   *  is the "what you're tuned to" surface now, moved out of the top info card per Callum's
   *  own call (redesign conversation, 2026-09-29). */
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

/** One line under the toggles: what auto step climb is doing — a request in progress, the
 *  last result, an FCU level waiting on the climb, or the next planned step. */
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
    lines.push(t('beyondAtcPanel.stepClimb.waitingForClimb', { level: flightLevel(status.waitingForClimbFt) }))
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

export function BeyondAtcRadios(props: BeyondAtcRadiosProps): React.JSX.Element {
  const { t } = useTranslation()
  const com1Current = props.facility
    ? t('beyondAtcPanel.stationFrequency', { station: props.facility.name, frequency: props.facility.frequency })
    : null
  // A switched-off COM2 comes through as {"label":"Radio Off","frequency":""}: show the label alone, not "Radio Off ()".
  const com2Current = props.com2
    ? props.com2.frequency
      ? t('beyondAtcPanel.stationFrequency', { station: props.com2.label, frequency: props.com2.frequency })
      : props.com2.label
    : null
  const departureAirport = props.progress?.from ?? null
  const arrivalAirport = props.progress?.to ?? null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <FrequencyRow
          label="COM1"
          current={com1Current}
          options={props.frequencyOptions}
          departureAirport={departureAirport}
          arrivalAirport={arrivalAirport}
          onSet={props.onSetFrequency}
        />
        <FrequencyRow
          label="COM2"
          current={com2Current}
          options={props.frequencyOptions}
          departureAirport={departureAirport}
          arrivalAirport={arrivalAirport}
          onSet={props.onSetFrequencyCom2}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <AutoToggle label={t('beyondAtcPanel.settings.autoTune')} value={props.autoTune} onSet={props.onSetAutoTune} />
        <AutoToggle label={t('beyondAtcPanel.settings.autoRespond')} value={props.autoRespond} onSet={props.onSetAutoRespond} />
        <AutoToggle label={t('beyondAtcPanel.settings.stepClimb')} value={props.stepClimb.enabled} onSet={props.onSetStepClimb} />
      </div>
      <StepClimbStatusLine status={props.stepClimb} />
    </div>
  )
}
