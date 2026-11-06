/**
 * The map's colours, in one place (winglog-backend docs/plans/v2-design.md, "The map"): magenta the plan, ink you and the flown track,
 * blue the ATC areas, grey the traffic, airfields, fixes and range rings, yellow the cleared taxi route. Every layer takes its colours
 * from here, per theme, the same way `simvars.ts` is the one home of SimVar names; the theme is read when a layer is created.
 */

export interface MapPalette {
  /** The base map: land, water, and land-use areas (parks, woods) a shade apart from the land. */
  land: string
  sea: string
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
}

const LIGHT: MapPalette = {
  land: '#efede6',
  sea: '#dce6ec',
  area: '#e6e3da',
  ink: '#1c1b19',
  ground: '#f3f1eb',
  plan: '#a61e6b',
  quiet: '#5e594f',
  label: '#1c1b19',
  halo: '#f3f1eb',
  atc: '#2a62a3',
  atcFillOpacity: 0.07,
  taxi: '#f2c200',
  taxiEdgeOpacity: 0.7
}

const DARK: MapPalette = {
  land: '#1d1d1b',
  sea: '#121416',
  area: '#242422',
  ink: '#ece9e1',
  ground: '#141413',
  plan: '#e26aae',
  quiet: '#a29e94',
  label: '#bdb8ad',
  halo: '#141413',
  atc: '#7fb0e8',
  atcFillOpacity: 0.09,
  taxi: '#facc15',
  taxiEdgeOpacity: 0
}

/**
 * @param dark Whether the dark theme is on.
 * @returns The map's colours for that theme.
 */
export function mapPalette(dark: boolean): MapPalette {
  return dark ? DARK : LIGHT
}
