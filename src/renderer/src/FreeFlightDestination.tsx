import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AirportSearch } from './AirportSearch'
import { displayIcao } from './display-icao'

const VALID_ICAO = /^[A-Z0-9]{2,5}$/

/**
 * The destination of a free flight that's already being tracked — the start dialog's
 * Destination is optional ("filled in on landing"), and this is how one is added or changed
 * afterwards (v1.1.1). Only a plan: the real touchdown still resolves the actual arrival.
 */
export function FreeFlightDestination(props: {
  /** The flight's current arrival — `ZZZZ` when none has been set. */
  arrIcao: string
  onChanged: () => void
}): React.JSX.Element {
  const isSet = props.arrIcao !== 'ZZZZ'
  const [value, setValue] = useState(isSet ? props.arrIcao : '')
  const [saving, setSaving] = useState(false)
  const candidate = value.trim().toUpperCase()
  const canSet = VALID_ICAO.test(candidate) && candidate !== props.arrIcao

  async function save(icao: string | null): Promise<void> {
    setSaving(true)
    try {
      await window.winglog.trackingSetDestination(icao)
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
      <span className="text-sm text-muted-foreground">Destination: {displayIcao(props.arrIcao)}</span>
      <div className="w-56">
        <AirportSearch value={value} onChange={setValue} placeholder="Set destination" />
      </div>
      <Button type="button" size="sm" variant="outline" disabled={!canSet || saving} onClick={() => save(candidate)}>
        Set
      </Button>
      {isSet && (
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => save(null)}>
          Clear
        </Button>
      )}
    </div>
  )
}
