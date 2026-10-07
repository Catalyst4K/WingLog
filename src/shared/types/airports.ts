/** Airports from the vendored reference data, and their weather. */

/** One match from the vendored OurAirports name/ICAO search — see resources/airports.csv. */
export interface AirportOption {
  icao: string
  name: string
  municipality: string | null
  isoCountry: string
}

/** OurAirports' `type` values WingLog keeps for the VFR map overlay. */
export type AirfieldType = 'large_airport' | 'medium_airport' | 'small_airport' | 'heliport' | 'seaplane_base'

/** One airfield with its position — the VFR overlay's airfields layer (resources/airports.csv). */
export interface Airfield {
  icao: string
  name: string
  type: AirfieldType
  latitude: number
  longitude: number
}

/** A METAR observation from aviationweather.gov (docs/decisions.md, 2026-09-02). */
export interface MetarReport {
  icao: string
  /** The raw METAR text, e.g. "METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020". */
  rawText: string
  /** ISO 8601 UTC — empty string if aviationweather.gov didn't report one. */
  observedUtc: string
  flightCategory: 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null
}
