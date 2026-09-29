import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcCom2, BeyondAtcFacility, BeyondAtcFrequencyOption, BeyondAtcProgress } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * BeyondATC's own live "Actions" menu and the COM1/COM2 radios control (Part 2 of
 * flightdeck-backend's docs/plans/beyondatc-integration.md) — two separate exports, each its
 * own card in `BeyondAtcPanel`'s dispatch-style card grid
 * (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md). Deliberately clean data/
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
}

export function BeyondAtcActions(props: BeyondAtcActionsProps): React.JSX.Element | null {
  if (props.actions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.actions.map((label) => (
        <Button
          key={label}
          type="button"
          variant="outline"
          size="sm"
          className="h-auto py-1.5 text-xs"
          onClick={() => props.onSelectAction(label)}
        >
          {label}
        </Button>
      ))}
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

/** One selectable station — real captures showed BeyondATC supplying several distinct
 *  Approach frequencies for the same airport, one per runway, so the runway (when present)
 *  is shown next to the frequency it actually applies to rather than just the station name. */
function FrequencyOptionButton(props: { station: BeyondAtcFrequencyOption; onSelect: (frequency: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const label = props.station.runways
    ? t('beyondAtcPanel.stationRunway', { station: props.station.name, frequency: props.station.frequency, runway: props.station.runways })
    : `${props.station.name} ${props.station.frequency}`
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto w-full justify-start py-1 text-left text-xs"
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
    <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
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
 *  airports) rather than the previous single dropdown. A popover, not a `Select`, since tabs
 *  need button/tabpanel semantics a listbox doesn't offer. */
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs">
          {t('beyondAtcPanel.selectFrequency')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
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
      </PopoverContent>
    </Popover>
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
}

export function BeyondAtcRadios(props: BeyondAtcRadiosProps): React.JSX.Element {
  const { t } = useTranslation()
  const com1Current = props.facility
    ? t('beyondAtcPanel.stationFrequency', { station: props.facility.name, frequency: props.facility.frequency })
    : null
  const com2Current = props.com2 ? t('beyondAtcPanel.stationFrequency', { station: props.com2.label, frequency: props.com2.frequency }) : null
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
      </div>
    </div>
  )
}
