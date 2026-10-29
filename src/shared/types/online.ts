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

/** The ATC areas the map draws, and how they are kept up to date (Settings → Online network). */
export interface AtcAreasStatus {
  /** Whether the app asks GitHub for newer areas by itself (default on). */
  auto: boolean
  /** Where the areas in use come from: the file bundled with this version, or the copy the app made from a newer release. */
  source: 'bundled' | 'downloaded'
  /** The VAT-Spy release in use, such as "v2610.1" (empty when no areas can be read). */
  vatspy: string
  /** The SimAware TRACON release in use, such as "v1.2.13". */
  tracon: string
  /** When the app last asked GitHub, as an ISO time, or null when it never has. */
  checkedAt: string | null
}

/** What a look for newer areas did. */
export interface AtcAreasCheck {
  /** "updated": newer areas are now in use. "current": already the newest. "failed": GitHub or the files could not be read, nothing changed. "skipped": none was due. */
  outcome: 'updated' | 'current' | 'failed' | 'skipped'
  status: AtcAreasStatus
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
   * 'shown': aircraft below, around the aircraft or the flight's departure, or the whole network while neither is known. 'off': the
   * switch is off. 'noNetwork': none chosen. 'needsVid': IVAO with no VID. 'unavailable': the feed has failed for 45 s, and the last
   * aircraft are dropped.
   */
  state: 'shown' | 'off' | 'noNetwork' | 'needsVid' | 'unavailable'
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
}

/** An ATIS station's frequency, for the ATC list: the text itself is in `AtisAnswer`. Only VATSIM's ATIS stations have one. */
export interface OnlineAtis {
  callsign: string
  /** The information letter, or null when none is given. */
  code: string | null
  /** MHz with three decimals, for example "128.075". Only ever shown, never tuned. */
  frequency: string
}

/** Which weather tab asks: the flight's departure, destination or alternate, or any other airport. */
export type AtisSlot = 'departure' | 'destination' | 'alternate' | 'custom'

/** One airport an ATIS is asked for, and the weather tab asking. */
export interface AtisRequest {
  icao: string
  slot: AtisSlot
}

/** Whether an ATIS is for departing aircraft, arriving ones, or both (the airport has one ATIS, or the network does not say). */
export type AtisKind = 'departure' | 'arrival' | 'single'

/** An ATIS as the weather panel shows it: text, never parsed into anything here, never HTML. */
export interface WeatherAtis {
  callsign: string
  /** The information letter, or null when none is given. */
  code: string | null
  kind: AtisKind
  lines: string[]
  /** The one runway the text names, when it names exactly one: a suggestion to show beside the text, never applied. */
  runway: string | null
}

/** What the network says for one request: 'shown' with its ATIS, 'none' when no ATIS is online there, 'unavailable' when it could not be read. */
export interface AirportAtis {
  icao: string
  slot: AtisSlot
  state: 'shown' | 'none' | 'unavailable'
  atis: WeatherAtis[]
}

/** The answer to a list of requests: in the same order. `network` is null with no network chosen (or IVAO without a VID): nothing is shown. */
export interface AtisAnswer {
  network: OnlineNetwork | null
  airports: AirportAtis[]
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

/** One staffed centre or approach area, with its shape: the map draws it and lists who is on it. */
export interface AtcArea {
  /** The area's id in the community data: the same on every refresh while it is staffed. */
  id: string
  kind: 'centre' | 'approach'
  /** The community data's name for it, such as "London ACC (Central) - London". */
  name: string
  /** Where its label sits: [longitude, latitude]. */
  at: [number, number]
  /** The shape, as a MultiPolygon's coordinates: [longitude, latitude] pairs, rounded to 4 decimals. */
  coordinates: number[][][][]
  /** Who is on it, nearest the gate first. */
  stations: OnlineStation[]
}

/** One airport with a staffed delivery, ground, tower or ATIS station, or an approach that has no area of its own. */
export interface AtcAirport {
  icao: string
  /** [longitude, latitude]. */
  at: [number, number]
  stations: OnlineStation[]
  atis: OnlineAtis[]
}

/**
 * The `networkAtc` live topic: where the chosen network's controllers are, for the map's ATC layer (winglog-backend
 * docs/plans/online-atc-map.md). The whole network, not just around the aircraft: only what is staffed is sent. 'off': the switch is off.
 * 'noNetwork': none chosen. 'needsVid': IVAO with no VID. 'unavailable': the feed has been failing past the time the last answer is kept.
 */
export interface NetworkAtc {
  network: OnlineNetwork | null
  state: 'shown' | 'off' | 'noNetwork' | 'needsVid' | 'unavailable'
  areas: AtcArea[]
  airports: AtcAirport[]
}

/** The `trafficLayers` live topic: the shared switches and what actually draws. Decided in main, in one function. */
export interface TrafficLayers {
  networkOn: boolean
  /** Off while the network's layer draws: the two switch each other off. */
  simOn: boolean
  /** Whether the screens offer the sim traffic button at all: the "Sim traffic button" setting. */
  simOffered: boolean
  /** The ATC layer's switch: it does not touch the two traffic switches, so traffic and ATC can show together. */
  atcOn: boolean
  /** What each screen draws now. */
  drawNetwork: boolean
  drawSim: boolean
  /** The ATC layer draws when its switch is on and a network is chosen (for IVAO, with a VID). */
  drawAtc: boolean
}
