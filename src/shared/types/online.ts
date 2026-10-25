/**
 * Online-network (VATSIM and IVAO) types shared by the main process and the screens: the settings, the traffic as a screen draws it, and
 * which traffic layers draw. Units are SI (metres, m/s, degrees true). No member numbers or names ever appear here: those stay in main
 * (winglog-backend docs/plans/vatsim-build.md, "The internal form").
 */

export type OnlineNetwork = 'vatsim' | 'ivao'

/** Settings → 3rd party → Online network. Stored in app_setting. */
export interface OnlineNetworkSettings {
  /** The one switch for every VATSIM and IVAO feature: null (None) shows none of them anywhere (Callum, 2026-10-25). */
  network: OnlineNetwork | null
  /** VATSIM CID: digits only, optional (recognising the pilot without it comes later). */
  vatsimCid: string | null
  /** IVAO VID: digits only. Required before any IVAO traffic or controller is shown (Regulation D.2). */
  ivaoVid: string | null
  /** Keep BeyondATC's prompts, taxi line, frequencies and auto step climb while online (default off: human ATC is the only voice). */
  keepBeyondAtcOnline: boolean
  /** Offer the sim traffic button on the map, whatever the network (default on). Off removes it from every screen. */
  simTrafficButton: boolean
}

/** One aircraft as a screen draws it: the network's, or the sim's. */
export interface TrafficAircraft {
  /** Unique within one payload: the callsign for a network, the SimConnect object id for the sim. */
  key: string
  callsign: string
  latitude: number
  longitude: number
  altitudeM: number
  groundSpeedMs: number
  headingDeg: number
  onGround: boolean
  aircraftIcao: string | null
  departure: string | null
  arrival: string | null
  /** Seconds between this position being reported and the payload being published: the glide starts from here. */
  ageS: number
}

/** The `networkTraffic` live topic. */
export interface NetworkTraffic {
  network: OnlineNetwork | null
  /**
   * 'shown': aircraft below. 'off': the switch is off. 'noNetwork': none chosen. 'needsVid': IVAO with no VID.
   * 'unavailable': the feed has failed for 45 s, and the last aircraft are dropped. 'noCentre': no position to centre on.
   */
  state: 'shown' | 'off' | 'noNetwork' | 'needsVid' | 'unavailable' | 'noCentre'
  aircraft: TrafficAircraft[]
}

/** The `simTraffic` live topic: the aircraft the sim itself lists around the pilot (BeyondATC's traffic, AI traffic), for the teal layer. */
export interface SimTraffic {
  /** 'off': the layer is not drawing. 'shown': aircraft below. 'unavailable': the sim could not be read (not running yet). */
  state: 'off' | 'shown' | 'unavailable'
  aircraft: TrafficAircraft[]
}

/** The onlineStatus live topic: whether the pilot's own flight is on the chosen network. */
export interface OnlineStatus {
  network: OnlineNetwork | null
  /**
   * 'unknown': not looked (no flight tracked, no network, or no answer from the feed yet). 'offline': the feed was read and the pilot is not
   * in it. 'online': found by member number. 'probably': found by a filed plan matching the flight, near the aircraft, with no member number.
   */
  state: 'unknown' | 'offline' | 'online' | 'probably'
  /** The callsign used on the network, when online or probably. */
  callsign: string | null
  /** The plan filed on the network, when online or probably and one is filed. */
  filedPlan: { departure: string | null; arrival: string | null; aircraftIcao: string | null } | null
  /** True when BeyondATC should be hidden and silent: online (or probably) and not asked to keep it. Decided in main, once. */
  hidesBeyondAtc: boolean
}

/** The kinds of station WingLog lists (VATSIM's facility numbers and IVAO's positions, in one set). */
export type OnlineStationPosition = 'fss' | 'del' | 'gnd' | 'twr' | 'app' | 'ctr'

/** One controller online at an airport. */
export interface OnlineStation {
  callsign: string
  /** MHz with three decimals, for example "118.700". Only ever shown, never tuned. */
  frequency: string
  position: OnlineStationPosition
  /** The controller's name when the network publishes it (VATSIM does, IVAO does not), else null. */
  name: string | null
}

/** An airport's ATIS, as text: never parsed into anything here, never HTML. */
export interface OnlineAtis {
  callsign: string
  /** The information letter, or null when none is given. */
  code: string | null
  lines: string[]
  /** The one runway the text names, when it names exactly one: a suggestion to show beside the text, never applied. */
  runway: string | null
}

/** Who is online at one airport. */
export interface OnlineAirportStations {
  icao: string
  stations: OnlineStation[]
  atis: OnlineAtis[]
}

/** The networkControllers live topic: the controllers and ATIS at the flight's departure, arrival and alternate airports. */
export interface NetworkControllers {
  network: OnlineNetwork | null
  airports: OnlineAirportStations[]
}

/** The `trafficLayers` live topic: the shared switches and what actually draws. Decided in main, in one function. */
export interface TrafficLayers {
  networkOn: boolean
  simOn: boolean
  /** Whether the screens offer the sim traffic button at all: the "Sim traffic button" setting. */
  simOffered: boolean
  /** What each screen draws now. */
  drawNetwork: boolean
  drawSim: boolean
  /** True while the sim switch is on but the network layer is drawing: the two are never drawn together. */
  simBlockedByNetwork: boolean
}
