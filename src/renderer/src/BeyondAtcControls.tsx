import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcCom2, BeyondAtcFacility, BeyondAtcFrequencyOption } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'

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

/** Groups the flat real frequency list by airport (confirmed live capture had entries with
 *  no `airportName` at all — a real enroute Center station — grouped under a fallback
 *  label rather than dropped). */
function groupFrequencyOptions(options: BeyondAtcFrequencyOption[], enrouteLabel: string): Map<string, BeyondAtcFrequencyOption[]> {
  const groups = new Map<string, BeyondAtcFrequencyOption[]>()
  for (const option of options) {
    const key = option.airportName || enrouteLabel
    const group = groups.get(key)
    if (group) group.push(option)
    else groups.set(key, [option])
  }
  return groups
}

function FrequencyRow(props: {
  label: string
  current: string | null
  options: BeyondAtcFrequencyOption[]
  onSet: (frequency: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const groups = useMemo(() => groupFrequencyOptions(props.options, t('beyondAtcPanel.enroute')), [props.options, t])

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
        {props.options.length > 0 && (
          <Select onValueChange={(frequency) => props.onSet(frequency)}>
            <SelectTrigger size="sm" className="h-7 text-xs" aria-label={t('beyondAtcPanel.selectFrequency')}>
              <SelectValue placeholder={t('beyondAtcPanel.selectFrequency')} />
            </SelectTrigger>
            <SelectContent>
              {[...groups.entries()].map(([airportName, stations]) => (
                <SelectGroup key={airportName}>
                  <SelectLabel>{airportName}</SelectLabel>
                  {stations.map((station) => (
                    <SelectItem key={`${station.name}-${station.frequency}`} value={station.frequency}>
                      {station.name} {station.frequency}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <FrequencyRow label="COM1" current={com1Current} options={props.frequencyOptions} onSet={props.onSetFrequency} />
        <FrequencyRow label="COM2" current={com2Current} options={props.frequencyOptions} onSet={props.onSetFrequencyCom2} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <AutoToggle label={t('beyondAtcPanel.settings.autoTune')} value={props.autoTune} onSet={props.onSetAutoTune} />
        <AutoToggle label={t('beyondAtcPanel.settings.autoRespond')} value={props.autoRespond} onSet={props.onSetAutoRespond} />
      </div>
    </div>
  )
}
