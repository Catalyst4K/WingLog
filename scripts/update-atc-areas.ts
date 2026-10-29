/**
 * Refreshes WingLog's bundled ATC coverage areas (`resources/atc-areas.json`) from VATSIM's community map data.
 *
 *   npm run data:atc-areas
 *
 * Downloads the latest release of the VAT-Spy Data Project (centre and FIR areas, and the callsign prefixes that name them) and of the
 * SimAware TRACON Project (approach and departure areas), both CC BY-SA 4.0, keeps only what WingLog draws, rounds coordinates to 4
 * decimals (about 11 m) and writes one compact file. The app now keeps its own copy up to date (winglog-backend
 * docs/plans/atc-areas-auto-update.md), so this only moves the floor it falls back on: run it before a release so a fresh install starts
 * current, and commit the result with its licence notice (`resources/atc-areas.LICENSE.txt`). The download and the conversion are the
 * app's own (`src/main/online/atc-areas-download.ts`), so a refresh here and in the app cannot differ.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadAreaFile, latestReleases, REAL_AREA_SOURCE } from '../src/main/online/atc-areas-download'

const USER_AGENT = 'WingLog/dev-data (+https://github.com/Catalyst4K/WingLog)'
const OUTPUT = join(process.cwd(), 'resources', 'atc-areas.json')

async function main(): Promise<void> {
  const releases = await latestReleases(REAL_AREA_SOURCE, (url, init) => fetch(url, init), USER_AGENT)
  const text = await downloadAreaFile(releases)
  writeFileSync(OUTPUT, text)
  const written = JSON.parse(text) as { firs: object; approaches: unknown[] }
  console.log(
    `Wrote ${OUTPUT}: ${Object.keys(written.firs).length} areas, ${written.approaches.length} approach areas (VAT-Spy ${releases.vatspy.tag}, TRACON ${releases.tracon.tag})`
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
