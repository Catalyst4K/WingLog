import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { AirportSearch } from './AirportSearch'

const VALID_ICAO = /^[A-Z0-9]{2,5}$/

/**
 * The departure or destination of a free flight that's already being tracked — the start
 * dialog leaves either optional, and this is how one is added or changed afterwards
 * (v1.1.1 destination, v1.1.2 departure). Both feed the Weather (METAR) dialog. The
 * destination is only a plan: the real touchdown still resolves the actual arrival.
 */
export function FreeFlightAirport(props: {
  kind: 'departure' | 'destination'
  /** The flight's current airport — `ZZZZ` when none has been set. */
  icao: string
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const noun = props.kind === 'departure' ? t('freeFlightAirport.departure') : t('freeFlightAirport.destination')
  const isSet = props.icao !== 'ZZZZ'
  const [value, setValue] = useState(isSet ? props.icao : '')
  const [saving, setSaving] = useState(false)
  const candidate = value.trim().toUpperCase()
  const canSet = VALID_ICAO.test(candidate) && candidate !== props.icao

  async function save(icao: string | null): Promise<void> {
    setSaving(true)
    try {
      if (props.kind === 'departure') await window.winglog.trackingSetDeparture(icao)
      else await window.winglog.trackingSetDestination(icao)
      if (icao === null) setValue('')
      props.onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">{noun}</span>
      <div className="w-56">
        <AirportSearch value={value} onChange={setValue} placeholder={t('freeFlightAirport.notSet')} />
      </div>
      {canSet && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={
            props.kind === 'departure' ? t('freeFlightAirport.setDeparture') : t('freeFlightAirport.setDestination')
          }
          disabled={saving}
          onClick={() => save(candidate)}
        >
          {t('freeFlightAirport.set')}
        </Button>
      )}
      {isSet && !canSet && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={
            props.kind === 'departure'
              ? t('freeFlightAirport.clearDeparture')
              : t('freeFlightAirport.clearDestination')
          }
          disabled={saving}
          onClick={() => save(null)}
        >
          {t('freeFlightAirport.clear')}
        </Button>
      )}
    </div>
  )
}
