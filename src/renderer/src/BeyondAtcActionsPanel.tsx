import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * BeyondATC's own live "Actions" menu (Part 2 of flightdeck-backend's docs/plans/
 * beyondatc-integration.md) plus the COM1/COM2 frequency picker — deliberately its own
 * component with a clean data/action interface, per that plan's explicit instruction: this
 * is what gets forwarded into the LAN server (lan-web-viewer.md) once that's built, so it
 * must not depend on BeyondAtcPanel's own transcript/status state.
 */
export interface BeyondAtcActionsPanelProps {
  actions: string[]
  onSelectAction: (label: string) => void
  com1Frequency: string | null
  com2Frequency: string | null
  onSetFrequency: (frequency: string) => void
  onSetFrequencyCom2: (frequency: string) => void
}

function FrequencyRow(props: { label: string; current: string | null; onSet: (frequency: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

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

export function BeyondAtcActionsPanel(props: BeyondAtcActionsPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (props.actions.length === 0 && props.com1Frequency === null && props.com2Frequency === null) return null

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
        <FrequencyRow label="COM1" current={props.com1Frequency} onSet={props.onSetFrequency} />
        <FrequencyRow label="COM2" current={props.com2Frequency} onSet={props.onSetFrequencyCom2} />
      </div>
    </div>
  )
}
