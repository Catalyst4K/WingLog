/**
 * `npm run logo-health`: asks the airline logo image service (images.kiwi.com) for logos and reports
 * which codes it can't serve (winglog-backend docs/plans/airline-logo-resilience.md step 4). Run by
 * hand around releases to see whether coverage is falling. It makes one request per code, a few at a
 * time and spaced out: the service is unofficial and keyless, so be gentle with it.
 *
 *   npm run logo-health                 the airlines in this machine's fleet
 *   npm run logo-health -- --all        every IATA code in resources/airlines.csv (thousands of requests)
 *   npm run logo-health -- BA SQ KA     the codes given
 *
 * Writes release/logo-health/results.json (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { thisMachinesUserDataDirectory } from '../src/main/platform/this-machine'
import {
  LOGO_URL_PREFIX,
  classifyLogo,
  fingerprint,
  iataCodesFromCsv,
  summariseHealth,
  type LogoAnswer,
  type LogoStatus
} from './logo-health-lib'

const CONCURRENCY = 4
const SPACING_MS = 150
const TIMEOUT_MS = 10_000
/** A code that no airline has, to learn what the service returns for a missing logo. */
const NO_SUCH_CODE = 'Q9'

async function fetchLogo(iata: string): Promise<LogoAnswer> {
  const response = await fetch(`${LOGO_URL_PREFIX}${encodeURIComponent(iata)}.png`, {
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}

/** @returns The IATA codes of the aircraft in this machine's fleet. */
function fleetCodes(): string[] {
  const dataDir = thisMachinesUserDataDirectory()
  const path = dataDir ? join(dataDir, 'winglog.db') : ''
  if (!path || !existsSync(path)) throw new Error('No WingLog database in the WingLog data folder')
  const sqlite = new Database(path, { readonly: true })
  try {
    const rows = sqlite
      .prepare(
        'SELECT DISTINCT operator_iata AS iata FROM aircraft WHERE operator_iata IS NOT NULL AND deleted_at IS NULL'
      )
      .all() as { iata: string }[]
    return rows.map((r) => r.iata.toUpperCase())
  } finally {
    sqlite.close()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const given = args.filter((a) => /^[A-Za-z0-9]{2}$/.test(a)).map((a) => a.toUpperCase())
  const codes = all
    ? iataCodesFromCsv(readFileSync(join('resources', 'airlines.csv'), 'utf8'))
    : given.length > 0
      ? given
      : [...new Set(fleetCodes())].sort()

  let standIn: string | null = null
  try {
    const answer = await fetchLogo(NO_SUCH_CODE)
    standIn = answer.status === 200 ? fingerprint(answer.bytes) : null
    console.log(
      `A code that doesn't exist (${NO_SUCH_CODE}) gets HTTP ${answer.status}${standIn ? ` and a stand-in image (${standIn})` : ''}.`
    )
  } catch (error) {
    console.log(`The service did not answer a test request: ${String(error)}`)
  }

  const results: { iata: string; status: LogoStatus }[] = []
  let next = 0
  async function worker(): Promise<void> {
    while (next < codes.length) {
      const iata = codes[next++]
      let status: LogoStatus
      try {
        status = classifyLogo(await fetchLogo(iata), standIn)
      } catch {
        status = 'error'
      }
      results.push({ iata, status })
      await new Promise((resolve) => setTimeout(resolve, SPACING_MS))
    }
  }
  console.log(`Checking ${codes.length} codes...`)
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const health = summariseHealth(results.sort((a, b) => a.iata.localeCompare(b.iata)))
  mkdirSync(join('release', 'logo-health'), { recursive: true })
  writeFileSync(join('release', 'logo-health', 'results.json'), JSON.stringify(health, null, 2))
  console.log(`${health.ok.length} of ${health.checked} have a logo.`)
  if (health.missing.length > 0) console.log(`No logo: ${health.missing.join(' ')}`)
  if (health.error.length > 0) console.log(`The service failed for: ${health.error.join(' ')}`)
  if (health.checked > 0 && health.error.length === health.checked) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
