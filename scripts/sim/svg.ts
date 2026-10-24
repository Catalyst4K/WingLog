/**
 * Small SVG map pieces for simulation reports: a frame fitted to an area, the taxi network, lines
 * and an aircraft marker (winglog-backend docs/plans/robustness/scenario-testing.md Part 6,
 * "Visual output"). Colours come from the report page's CSS tokens, so maps follow its light or
 * dark theme.
 */
import type { NavdataTaxiSegment } from '../../src/shared/ipc'
import { offsetBy } from '../../src/shared/geo'

/** [lon, lat], as the app's traced routes are. */
export type LonLat = [number, number]

/** A map area: west, east, south, north, in degrees. */
export interface Bounds {
  west: number
  east: number
  south: number
  north: number
}

export interface Frame {
  width: number
  height: number
  bounds: Bounds
  x: (lon: number) => number
  y: (lat: number) => number
}

/** The yellow of the app's taxi line (use-taxi-route-highlight.ts's ROUTE_PAINT). */
export const TAXI_LINE_COLOUR = '#facc15'
/** The real track. */
export const TRACK_COLOUR = '#1c7ed6'
/** Numbered decision points, in order. */
export const STEP_COLOURS = ['#e8590c', '#9c36b5', '#2f9e44', '#c2255c', '#1098ad']

/** Escapes text for HTML or SVG: report text includes BeyondATC's, which is external data. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Bounds around some points, with `padDeg` added on every side. */
export function boundsOf(points: LonLat[], padDeg: number): Bounds {
  if (points.length === 0) throw new Error('boundsOf: no points')
  const lons = points.map((p) => p[0])
  const lats = points.map((p) => p[1])
  return {
    west: Math.min(...lons) - padDeg,
    east: Math.max(...lons) + padDeg,
    south: Math.min(...lats) - padDeg,
    north: Math.max(...lats) + padDeg
  }
}

/** A square area `halfM` metres each way around a point. */
export function boundsAround(at: { lat: number; lon: number }, halfM: number): Bounds {
  const sw = offsetBy(at, -halfM, -halfM)
  const ne = offsetBy(at, halfM, halfM)
  return { west: sw.lon, east: ne.lon, south: sw.lat, north: ne.lat }
}

/** Fits bounds to `width`, keeping the map's real proportions within [minHeight, maxHeight]. */
export function makeFrame(bounds: Bounds, width: number, minHeight: number, maxHeight: number): Frame {
  const k = Math.cos((((bounds.south + bounds.north) / 2) * Math.PI) / 180)
  const natural = (width * (bounds.north - bounds.south)) / ((bounds.east - bounds.west) * k)
  const height = Math.max(minHeight, Math.min(maxHeight, natural))
  return {
    width,
    height,
    bounds,
    x: (lon) => ((lon - bounds.west) / (bounds.east - bounds.west)) * width,
    y: (lat) => height - ((lat - bounds.south) / (bounds.north - bounds.south)) * height
  }
}

const n = (value: number): string => value.toFixed(1)

/** The taxi network segments with an end inside the frame, as thin lines. */
export function networkLines(frame: Frame, segments: NavdataTaxiSegment[]): string {
  const { west, east, south, north } = frame.bounds
  const inside = (lat: number, lon: number): boolean =>
    lon >= west && lon <= east && lat >= south && lat <= north
  return segments
    .filter((s) => inside(s.startLat, s.startLon) || inside(s.endLat, s.endLon))
    .map(
      (s) =>
        `<line x1="${n(frame.x(s.startLon))}" y1="${n(frame.y(s.startLat))}" x2="${n(frame.x(s.endLon))}" y2="${n(frame.y(s.endLat))}" stroke="var(--net)" stroke-width="1"/>`
    )
    .join('')
}

/**
 * Each named taxiway's name, once per connected piece of it with an end inside the frame, at the middle of that piece's longest
 * segment: for reading a route off the map.
 */
export function networkLabels(
  frame: Frame,
  segments: NavdataTaxiSegment[],
  fontSize = 11,
  everySegment = false
): string {
  const { west, east, south, north } = frame.bounds
  const inside = (lat: number, lon: number): boolean =>
    lon >= west && lon <= east && lat >= south && lat <= north
  const key = (lat: number, lon: number): string => `${lat.toFixed(7)},${lon.toFixed(7)}`
  const shown = segments.filter(
    (s) => s.name !== null && (inside(s.startLat, s.startLon) || inside(s.endLat, s.endLon))
  )
  // Union-find over shared endpoints, per name.
  const parent = shown.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const byEnd = new Map<string, number>()
  shown.forEach((s, i) => {
    if (everySegment) return
    for (const end of [key(s.startLat, s.startLon), key(s.endLat, s.endLon)]) {
      const k = `${s.name}|${end}`
      const other = byEnd.get(k)
      if (other === undefined) byEnd.set(k, i)
      else parent[find(i)] = find(other)
    }
  })
  const longest = new Map<number, { i: number; px: number }>()
  shown.forEach((s, i) => {
    const px = Math.hypot(frame.x(s.endLon) - frame.x(s.startLon), frame.y(s.endLat) - frame.y(s.startLat))
    const root = find(i)
    const best = longest.get(root)
    if (!best || px > best.px) longest.set(root, { i, px })
  })
  return [...longest.values()]
    .map(({ i }) => {
      const s = shown[i]
      const x = (frame.x(s.startLon) + frame.x(s.endLon)) / 2
      const y = (frame.y(s.startLat) + frame.y(s.endLat)) / 2
      return `<text x="${n(x)}" y="${n(y)}" fill="var(--fg)" fill-opacity="0.75" font-size="${fontSize}" text-anchor="middle" dominant-baseline="middle" paint-order="stroke" stroke="var(--map)" stroke-width="3">${escapeHtml(s.name ?? '')}</text>`
    })
    .join('')
}

/** A line through points. `attrs` are extra SVG attributes (stroke, width, dashes). */
export function polyline(frame: Frame, points: LonLat[], attrs: string): string {
  if (points.length === 0) return ''
  const coords = points.map(([lon, lat]) => `${n(frame.x(lon))},${n(frame.y(lat))}`).join(' ')
  return `<polyline points="${coords}" fill="none" stroke-linejoin="round" stroke-linecap="round" ${attrs}/>`
}

/** An arrowhead at a point, pointing along a heading (degrees true). */
export function aircraftMarker(
  frame: Frame,
  at: { lat: number; lon: number },
  headingDeg: number,
  size = 11
): string {
  const x = frame.x(at.lon)
  const y = frame.y(at.lat)
  const a = (headingDeg * Math.PI) / 180
  const point = (angle: number, r: number): string =>
    `${n(x + r * Math.sin(angle))},${n(y - r * Math.cos(angle))}`
  return `<polygon points="${point(a, size)} ${point(a + 2.5, size * 0.7)} ${n(x)},${n(y)} ${point(a - 2.5, size * 0.7)}" fill="var(--fg)" stroke="var(--map)" stroke-width="1.5"/>`
}

/** A numbered dot marking a decision point. */
export function stepMarker(
  frame: Frame,
  at: { lat: number; lon: number },
  label: string,
  colour: string
): string {
  const x = frame.x(at.lon)
  const y = frame.y(at.lat)
  return `<circle cx="${n(x)}" cy="${n(y)}" r="7" fill="${colour}" stroke="var(--map)" stroke-width="2"/><text x="${n(x + 10)}" y="${n(y - 9)}" fill="${colour}" font-size="15" font-weight="700">${escapeHtml(label)}</text>`
}

/** Wraps map content in an `<svg>` sized to the frame. */
export function svg(frame: Frame, content: string, label: string): string {
  return `<svg viewBox="0 0 ${frame.width} ${Math.round(frame.height)}" width="100%" role="img" aria-label="${escapeHtml(label)}" style="background:var(--map);border-radius:8px">${content}</svg>`
}
