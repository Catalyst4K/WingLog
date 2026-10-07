/**
 * Geodesy for the whole app: one Earth radius, one metres-per-degree constant, and every
 * distance, bearing and projection built on them (winglog-backend docs/coding-standards.md §1;
 * robustness/code-standards-audit.md phase 2).
 *
 * Two families:
 * - **Great circle** (haversine, bearing, destination): for anything over a few kilometres, such as
 *   airport distances, route legs and range rings.
 * - **Local flat projection** (metres east/north on a plane tangent at a reference latitude): for
 *   airport-scale geometry such as taxiways, runways, stands and track simplification, where it's
 *   within a few metres and far cheaper.
 */

/** Mean Earth radius (IUGG), in metres. */
export const EARTH_RADIUS_M = 6_371_008.8
/** One nautical mile, in metres. */
export const METRES_PER_NM = 1852
/** Metres per degree of latitude, for the local flat projection. Checked against EGKB's real
 *  runway 03/21: within 0.2° and 5 m over 1.8 km (winglog-backend docs/navdata-notes.md). */
export const METRES_PER_DEGREE_LAT = 111_320

const RAD = Math.PI / 180

/** A position in degrees. */
export interface LatLon {
  lat: number
  lon: number
}

/** Metres east and north of a reference point. */
export interface LocalXy {
  x: number
  y: number
}

/**
 * Great-circle distance (haversine).
 *
 * @param a One end.
 * @param b The other end.
 * @returns Metres.
 */
export function greatCircleM(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLon = (b.lon - a.lon) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Great-circle distance.
 *
 * @param a One end.
 * @param b The other end.
 * @returns Nautical miles.
 */
export function greatCircleNm(a: LatLon, b: LatLon): number {
  return greatCircleM(a, b) / METRES_PER_NM
}

/**
 * Initial true bearing from `a` to `b` on the great circle.
 *
 * @param a Where the bearing is taken from.
 * @param b Where it points to.
 * @returns Degrees true, 0 to 360.
 */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const dLon = (b.lon - a.lon) * RAD
  const y = Math.sin(dLon) * Math.cos(b.lat * RAD)
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLon)
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360
}

/**
 * The point `distanceM` from `from` along the great circle starting on `bearingDeg`.
 * Longitude is left unwrapped, so a ring drawn across the antimeridian stays continuous; use
 * wrapLongitude for a canonical value.
 *
 * @param from The start.
 * @param bearingDeg Degrees true.
 * @param distanceM Metres.
 * @returns The point reached, longitude unwrapped.
 */
export function destinationPoint(from: LatLon, bearingDeg: number, distanceM: number): LatLon {
  const d = distanceM / EARTH_RADIUS_M
  const brg = bearingDeg * RAD
  const lat1 = from.lat * RAD
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg))
  const dLon = Math.atan2(
    Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  )
  return { lat: lat2 / RAD, lon: from.lon + dLon / RAD }
}

/**
 * A longitude brought into -180 to 180.
 *
 * @param lon Degrees, any value.
 * @returns Degrees, -180 to 180.
 */
export function wrapLongitude(lon: number): number {
  return ((((lon + 540) % 360) + 360) % 360) - 180
}

/**
 * Metres per degree of longitude at a latitude, for the local flat projection.
 *
 * @param latDeg Degrees.
 * @returns Metres.
 */
export function metresPerDegreeLon(latDeg: number): number {
  return METRES_PER_DEGREE_LAT * Math.cos(latDeg * RAD)
}

/**
 * A position on the flat plane tangent at `refLatDeg`: metres east of longitude 0 and north of
 * the equator, at that latitude's scale. Only differences between projected points mean
 * anything, and only near the reference latitude.
 *
 * @param p The position.
 * @param refLatDeg The latitude the plane is scaled at, in degrees.
 * @returns Metres east and north.
 */
export function toLocalXy(p: LatLon, refLatDeg: number): LocalXy {
  return { x: p.lon * metresPerDegreeLon(refLatDeg), y: p.lat * METRES_PER_DEGREE_LAT }
}

/**
 * Metres east and north of `origin`, on the plane tangent at the origin's latitude.
 *
 * @param origin The reference point.
 * @param p The point measured.
 * @returns Metres east and north (negative: west, south).
 */
export function offsetFrom(origin: LatLon, p: LatLon): { eastM: number; northM: number } {
  return {
    eastM: (p.lon - origin.lon) * metresPerDegreeLon(origin.lat),
    northM: (p.lat - origin.lat) * METRES_PER_DEGREE_LAT
  }
}

/**
 * The point `eastM` east and `northM` north of `origin`, on the plane tangent at the origin's
 * latitude: the inverse of offsetFrom.
 *
 * @param origin The reference point.
 * @param eastM Metres east (negative: west).
 * @param northM Metres north (negative: south).
 * @returns The offset point.
 */
export function offsetBy(origin: LatLon, eastM: number, northM: number): LatLon {
  return {
    lat: origin.lat + northM / METRES_PER_DEGREE_LAT,
    lon: origin.lon + eastM / metresPerDegreeLon(origin.lat)
  }
}

/**
 * Straight-line distance on the local flat plane.
 *
 * @param a One end.
 * @param b The other end.
 * @param refLatDeg The latitude the plane is scaled at; `a`'s by default.
 * @returns Metres.
 */
export function flatDistanceM(a: LatLon, b: LatLon, refLatDeg: number = a.lat): number {
  return Math.hypot((a.lat - b.lat) * METRES_PER_DEGREE_LAT, (a.lon - b.lon) * metresPerDegreeLon(refLatDeg))
}

/**
 * Distance from `p` to the infinite line through `a` and `b`, on the plane tangent at their
 * midpoint latitude (re-scaled per line, so it holds over routes spanning many degrees).
 *
 * @param p The point measured.
 * @param a One point on the line.
 * @param b Another point on the line.
 * @returns Metres.
 */
export function pointToLineM(p: LatLon, a: LatLon, b: LatLon): number {
  const { px, py, dx, dy, ax, ay } = lineFrame(p, a, b)
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay)
  return Math.abs(dx * (py - ay) - dy * (px - ax)) / Math.sqrt(lengthSq)
}

/**
 * Distance from `p` to the segment from `a` to `b` (not the line beyond its ends), on the plane
 * tangent at their midpoint latitude.
 *
 * @param p The point measured.
 * @param a The segment's start.
 * @param b The segment's end.
 * @returns Metres.
 */
export function pointToSegmentM(p: LatLon, a: LatLon, b: LatLon): number {
  const { px, py, dx, dy, ax, ay } = lineFrame(p, a, b)
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function lineFrame(
  p: LatLon,
  a: LatLon,
  b: LatLon
): { px: number; py: number; ax: number; ay: number; dx: number; dy: number } {
  const refLat = (a.lat + b.lat) / 2
  const pp = toLocalXy(p, refLat)
  const pa = toLocalXy(a, refLat)
  const pb = toLocalXy(b, refLat)
  return { px: pp.x, py: pp.y, ax: pa.x, ay: pa.y, dx: pb.x - pa.x, dy: pb.y - pa.y }
}
