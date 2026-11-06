/**
 * The map's colours, in one place (winglog-backend docs/plans/v2-design.md, "The map"): magenta the plan, ink you and the flown track,
 * blue the ATC areas, grey the traffic, airfields, fixes and range rings, yellow the cleared taxi route. Every layer takes its colours
 * from here, per theme, the same way `simvars.ts` is the one home of SimVar names; the theme is read when a layer is created.
 */

export interface MapPalette {
  /** The base map: land, water, and land-use areas (parks, woods) a shade apart from the land. */
  land: string
  sea: string
  /** Parks and woods. */
  green: string
  /** Other land use (residential, industrial), a shade apart from the land. */
  area: string
  /** What happened: the flown track, the own aircraft. Near-black on the light map, paper on the dark one. */
  ink: string
  /** The map's ground colour, for outlines that must read as a gap (the aircraft's edge). */
  ground: string
  /** The plan: the route and its procedures. */
  plan: string
  /** Everything else that is only there: fix symbols, traffic, airfields, range rings. */
  quiet: string
  /** Labels on the map, and the halo that lifts them off whatever is under them. */
  label: string
  halo: string
  /** ATC areas and the tower ring. */
  atc: string
  /** How much the centre areas are tinted. */
  atcFillOpacity: number
  /** The cleared taxi route, and the dark edge that makes it read on the light map (none on the dark one). */
  taxi: string
  taxiEdgeOpacity: number
  /** The hold-short bar and its label. */
  holdBar: string
}

const LIGHT: MapPalette = {
  land: '#f1eee6',
  sea: '#b4d1e6',
  green: '#d2e2c0',
  area: '#e5e0d2',
  ink: '#1c1b19',
  ground: '#ebe8de',
  plan: '#a61e6b',
  quiet: '#5e594f',
  label: '#1c1b19',
  halo: '#ebe8de',
  atc: '#2a62a3',
  atcFillOpacity: 0.07,
  taxi: '#f2c200',
  taxiEdgeOpacity: 0.7,
  holdBar: '#c62a1f'
}

const DARK: MapPalette = {
  land: '#1e1e1b',
  sea: '#17314a',
  green: '#1f3322',
  area: '#2a2925',
  ink: '#ece9e1',
  ground: '#100f0e',
  plan: '#e26aae',
  quiet: '#a29e94',
  label: '#bdb8ad',
  halo: '#100f0e',
  atc: '#7fb0e8',
  atcFillOpacity: 0.09,
  taxi: '#facc15',
  taxiEdgeOpacity: 0,
  holdBar: '#f0645a'
}

/**
 * @param dark Whether the dark theme is on.
 * @returns The map's colours for that theme.
 */
export function mapPalette(dark: boolean): MapPalette {
  return dark ? DARK : LIGHT
}
