/**
 * A stand-in for GitHub's releases of the two community projects the ATC areas are made from (winglog-backend
 * docs/plans/atc-areas-auto-update.md), for the end-to-end test: the latest-release JSON for each repository and the three release
 * files, on this machine. The app is pointed at it by WINGLOG_E2E_ATC_AREAS_URL, which only an unpackaged build honours. The files are
 * small and invented: shapes are tiny squares, and the names are not real facilities.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Enough areas that WingLog accepts the result as a plausible replacement for the real bundled file (it needs about half as many). */
const AREAS = 1600

const SQUARE = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0]
]

/** The release files of one pair of releases. */
function files(): Record<string, string> {
  const firs = Array.from({ length: AREAS }, (_, i) => `Z${i}|Invented area ${i}|Z${i}|Z${i}`)
  return {
    'VATSpy.dat': ['[FIRs]', ...firs, '[UIRs]', ''].join('\r\n'),
    'Boundaries.geojson': JSON.stringify({
      features: Array.from({ length: AREAS }, (_, i) => ({
        properties: { id: `Z${i}`, label_lon: '0.5', label_lat: '0.5' },
        geometry: { type: 'Polygon', coordinates: [SQUARE] }
      }))
    }),
    'TRACONBoundaries.geojson': JSON.stringify({
      features: Array.from({ length: AREAS }, (_, i) => ({
        properties: { id: `T${i}`, prefix: [`T${i}`], suffix: 'APP', name: `Invented approach ${i}` },
        geometry: { type: 'Polygon', coordinates: [SQUARE] }
      }))
    })
  }
}

/** A running fake. */
export interface FakeAreaReleases {
  /** The address to hand the app as WINGLOG_E2E_ATC_AREAS_URL. */
  url: string
  /** Every path the app asked for, in order. */
  requests: string[]
  close: () => Promise<void>
}

/**
 * @param tags The release tags to offer for each project.
 * @returns The running server.
 */
export async function startFakeAreaReleases(tags: {
  vatspy: string
  tracon: string
}): Promise<FakeAreaReleases> {
  const served = files()
  const requests: string[] = []
  let base = ''
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    requests.push(path)
    const release = (tag: string, names: string[]): string =>
      JSON.stringify({
        tag_name: tag,
        assets: names.map((name) => ({ name, browser_download_url: `${base}/files/${tag}/${name}` }))
      })
    res.setHeader('Content-Type', 'application/json')
    if (path === '/repos/vatsimnetwork/vatspy-data-project/releases/latest') {
      res.end(release(tags.vatspy, ['VATSpy.dat', 'Boundaries.geojson']))
    } else if (path === '/repos/vatsimnetwork/simaware-tracon-project/releases/latest') {
      res.end(release(tags.tracon, ['TRACONBoundaries.geojson']))
    } else {
      const name = path.split('/').pop() ?? ''
      const body = served[name]
      res.statusCode = body === undefined ? 404 : 200
      res.end(body ?? 'not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: base,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
