import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AirportSearch } from './AirportSearch'
import { displayIcao } from './display-icao'

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
  const noun = props.kind === 'departure' ? 'Departure' : 'Destination'
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
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {noun}: {displayIcao(props.icao)}
      </span>
      <div className="w-56">
        <AirportSearch value={value} onChange={setValue} placeholder={`Set ${props.kind}`} />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Set ${props.kind}`}
        disabled={!canSet || saving}
        onClick={() => save(candidate)}
      >
        Set
      </Button>
      {isSet && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Clear ${props.kind}`}
          disabled={saving}
          onClick={() => save(null)}
        >
          Clear
        </Button>
      )}
    </div>
  )
}
