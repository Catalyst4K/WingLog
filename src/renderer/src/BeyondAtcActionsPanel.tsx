import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BeyondAtcFrequencyOption } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * BeyondATC's own live "Actions" menu (Part 2 of flightdeck-backend's docs/plans/
 * beyondatc-integration.md) plus the COM1/COM2 frequency picker — deliberately its own
 * component with a clean data/action interface, per that plan's explicit instruction: this
 * is what gets forwarded into the LAN server (lan-web-viewer.md) once that's built, so it
 * must not depend on BeyondAtcPanel's own transcript/status state.
 *
 * AutoTune/AutoRespond (below) are Callum's own explicit decision from the redesign
 * conversation: a separate settings block, not toggles inline on each frequency row
 * (flightdeck-backend's docs/plans/beyondatc-panel-redesign.md). Both commands and the
 * frequency list are confirmed working live, 2026-09-29 (docs/beyondatc-notes.md).
 */
export interface BeyondAtcActionsPanelProps {
  actions: string[]
  onSelectAction: (label: string) => void
  com1Frequency: string | null
  com2Frequency: string | null
  onSetFrequency: (frequency: string) => void
  onSetFrequencyCom2: (frequency: string) => void
  /** BeyondATC's own real frequency list for the flight's airports (`frequencies`,
   *  requested automatically on connect) — lets a station be picked directly instead of
   *  typed blind. Manual entry below stays available regardless, for anything not listed. */
  frequencyOptions: BeyondAtcFrequencyOption[]
  autoTune: boolean | null
  autoRespond: boolean | null
  onSetAutoTune: (value: boolean) => void
  onSetAutoRespond: (value: boolean) => void
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
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs font-medium text-foreground">{props.label}</span>
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{props.current ?? t('beyondAtcPanel.frequencyUnknown')}</span>
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

export function BeyondAtcActionsPanel(props: BeyondAtcActionsPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (
    props.actions.length === 0 &&
    props.com1Frequency === null &&
    props.com2Frequency === null &&
    props.autoTune === null &&
    props.autoRespond === null
  ) {
    return null
  }

  return (
    <div className="flex flex-col gap-2">
      {props.actions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-foreground">{t('beyondAtcPanel.actions')}</p>
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
        </div>
      )}
      <div className="flex flex-col gap-1">
        <FrequencyRow label="COM1" current={props.com1Frequency} options={props.frequencyOptions} onSet={props.onSetFrequency} />
        <FrequencyRow label="COM2" current={props.com2Frequency} options={props.frequencyOptions} onSet={props.onSetFrequencyCom2} />
      </div>
      {(props.autoTune !== null || props.autoRespond !== null) && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-foreground">{t('beyondAtcPanel.settings.title')}</p>
          <div className="flex flex-wrap gap-1.5">
            <AutoToggle label={t('beyondAtcPanel.settings.autoTune')} value={props.autoTune} onSet={props.onSetAutoTune} />
            <AutoToggle label={t('beyondAtcPanel.settings.autoRespond')} value={props.autoRespond} onSet={props.onSetAutoRespond} />
          </div>
        </div>
      )}
    </div>
  )
}
