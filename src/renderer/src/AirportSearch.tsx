import type { AirportOption } from '@shared/ipc'
import { Combobox } from './components/Combobox'

/**
 * Free-text ICAO entry (always works, even if the vendored list is missing an airport)
 * plus a debounced name/ICAO search dropdown (docs/decisions.md — vendored OurAirports
 * slice). Shared by the Fleet form's "Current airport" field and Dispatch's
 * departure/destination fields.
 */
export function AirportSearch(props: {
  value: string
  onChange: (icao: string) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <Combobox
      value={props.value}
      onChange={(value) => props.onChange(value.toUpperCase())}
      search={(query) => window.winglog.airportSearch(query)}
      getOptionKey={(r: AirportOption) => r.icao}
      getOptionValue={(r) => r.icao}
      getOptionLabel={(r) =>
        `${r.icao} — ${r.name}${r.municipality ? ` (${r.municipality}, ${r.isoCountry})` : ` (${r.isoCountry})`}`
      }
      placeholder={props.placeholder ?? 'ICAO or search by name'}
    />
  )
}
