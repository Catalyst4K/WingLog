/**
 * Refreshes WingLog's bundled ATC coverage areas (`resources/atc-areas.json`) from VATSIM's community map data.
 *
 *   npm run data:atc-areas
 *
 * Downloads the latest release of the VAT-Spy Data Project (centre and FIR areas, and the callsign prefixes that name them) and of the
 * SimAware TRACON Project (approach and departure areas), both CC BY-SA 4.0, keeps only what WingLog draws, rounds coordinates to 4
 * decimals (about 11 m) and writes one compact file. Run before each release; the result is committed with its licence notice
 * (`resources/atc-areas.LICENSE.txt`). Plan: winglog-backend docs/plans/online-atc-map.md, D1.
 *
 * The files are third-party data: every shape is checked here and again when WingLog loads it. Only https addresses on github.com's own
 * hosts are fetched.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const USER_AGENT = 'WingLog/dev-data (+https://github.com/Catalyst4K/WingLog)'
const VATSPY_REPO = 'vatsimnetwork/vatspy-data-project'
const TRACON_REPO = 'vatsimnetwork/simaware-tracon-project'
const OUTPUT = join(process.cwd(), 'resources', 'atc-areas.json')
/** Hosts a release asset may be served from. */
const ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

interface Release {
  tag: string
  asset: (name: string) => Promise<string>
}

/**
 * @param url An https address on GitHub's hosts.
 * @returns Its text.
 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return response.text()
}

/**
 * @param repo A GitHub repository, "owner/name".
 * @returns Its latest release: the tag and a way to download one of its assets.
 */
async function latestRelease(repo: string): Promise<Release> {
  const info = JSON.parse(await fetchText(`https://api.github.com/repos/${repo}/releases/latest`)) as {
    tag_name?: unknown
    assets?: { name?: unknown; browser_download_url?: unknown }[]
  }
  if (typeof info.tag_name !== 'string' || !Array.isArray(info.assets))
    throw new Error(`No release for ${repo}`)
  const assets = info.assets
  return {
    tag: info.tag_name,
    asset: async (name) => {
      const found = assets.find((a) => a.name === name)
      const address =
        typeof found?.browser_download_url === 'string' ? new URL(found.browser_download_url) : null
      if (!address || address.protocol !== 'https:' || !ASSET_HOSTS.has(address.hostname)) {
        throw new Error(`${repo} ${info.tag_name} has no usable ${name}`)
      }
      return fetchText(address.toString())
    }
  }
}

/** @returns A coordinate rounded to 4 decimals. */
const round = (value: number): number => Math.round(value * 1e4) / 1e4

/**
 * @param lon A label's longitude as the community data writes it (a number as text, or a number, or absent).
 * @param lat Its latitude.
 * @returns The label point, or null when either is missing or not a number.
 */
function labelPoint(lon: unknown, lat: unknown): [number, number] | null {
  if (lon === undefined || lat === undefined || lon === '' || lat === '') return null
  const point: [number, number] = [Number(lon), Number(lat)]
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) ? [round(point[0]), round(point[1])] : null
}

/**
 * @param geometry A GeoJSON Polygon or MultiPolygon.
 * @returns Its rings as a MultiPolygon's coordinates, rounded.
 */
function multiPolygon(geometry: { type?: unknown; coordinates?: unknown }): number[][][][] {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  if ((geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(polygons)) {
    throw new Error('Not a polygon')
  }
  return (polygons as number[][][][]).map((polygon) =>
    polygon.map((ring) => ring.map(([lon, lat]) => [round(lon), round(lat)]))
  )
}

/**
 * @param text VATSpy.dat.
 * @param section A section's name, such as "FIRs".
 * @returns That section's data lines, split on "|".
 */
function datSection(text: string, section: string): string[][] {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(`[${section}]`)
  if (start < 0) throw new Error(`No [${section}] in VATSpy.dat`)
  const rows: string[][] = []
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('['); i++) {
    if (lines[i] && !lines[i].startsWith(';')) rows.push(lines[i].split('|'))
  }
  return rows
}

async function main(): Promise<void> {
  const vatspy = await latestRelease(VATSPY_REPO)
  const tracon = await latestRelease(TRACON_REPO)
  const dat = await vatspy.asset('VATSpy.dat')
  const boundaries = JSON.parse(await vatspy.asset('Boundaries.geojson')) as { features: Feature[] }
  const traconBoundaries = JSON.parse(await tracon.asset('TRACONBoundaries.geojson')) as {
    features: Feature[]
  }

  // [FIRs]: ICAO|NAME|CALLSIGN PREFIX|FIR BOUNDARY. An empty prefix means the ICAO code is the prefix.
  const prefixes: Record<string, string> = {}
  const icaoBoundaries: Record<string, string> = {}
  const names: Record<string, string> = {}
  for (const [icao, name, prefix, boundary] of datSection(dat, 'FIRs')) {
    const id = boundary || icao
    prefixes[(prefix || icao).toUpperCase()] ??= id
    icaoBoundaries[icao.toUpperCase()] ??= id
    names[id] ??= name
  }
  // [UIRs]: ID|NAME|FIR,FIR,...
  const uirs: Record<string, { name: string; firs: string[] }> = {}
  for (const [id, name, firs] of datSection(dat, 'UIRs'))
    uirs[id.toUpperCase()] = { name, firs: firs.split(',') }

  const firs: Record<string, FirArea> = {}
  for (const feature of boundaries.features) {
    const { id, label_lon: lon, label_lat: lat, oceanic } = feature.properties as FirProperties
    if (typeof id !== 'string') continue
    firs[id] = {
      name: names[id] ?? id,
      at: labelPoint(lon, lat),
      oceanic: oceanic === '1' || oceanic === 1 || oceanic === true,
      coordinates: multiPolygon(feature.geometry)
    }
  }

  const approaches = traconBoundaries.features.map((feature) => {
    const p = feature.properties as TraconProperties
    return {
      id: String(p.id),
      prefix: p.prefix.map((x) => x.toUpperCase()),
      suffix: p.suffix === 'DEP' ? 'DEP' : 'APP',
      name: String(p.name),
      at: labelPoint(p.label_lon, p.label_lat),
      coordinates: multiPolygon(feature.geometry)
    }
  })

  const out = {
    sources: { vatspy: vatspy.tag, tracon: tracon.tag },
    prefixes,
    icaoBoundaries,
    uirs,
    firs,
    approaches
  }
  writeFileSync(OUTPUT, JSON.stringify(out))
  console.log(
    `Wrote ${OUTPUT}: ${Object.keys(firs).length} areas, ${approaches.length} approach areas (VAT-Spy ${vatspy.tag}, TRACON ${tracon.tag})`
  )
}

interface Feature {
  properties: unknown
  geometry: { type?: unknown; coordinates?: unknown }
}
interface FirProperties {
  id?: unknown
  label_lon?: unknown
  label_lat?: unknown
  oceanic?: unknown
}
interface TraconProperties {
  id: unknown
  prefix: string[]
  suffix?: unknown
  name: unknown
  label_lon?: unknown
  label_lat?: unknown
}
interface FirArea {
  name: string
  at: [number, number] | null
  oceanic: boolean
  coordinates: number[][][][]
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
