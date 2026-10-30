/**
 * Records a network's live feed (VATSIM or IVAO) to disk, for the parsers' fixtures and the Step 0 checks.
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/online-capture.ts vatsim|ivao <minutes>
 *
 * Fetches every 15 s (the networks' own rate: never faster, IVAO bans the IP) with WingLog's User-Agent, and writes each raw response
 * to release/online-capture/<network>/ (gitignored). Raw IVAO data is members-only (Regulation D.2) and stays on this machine; only
 * invented fixtures are committed. Writes nowhere under src/.
 * Plan: winglog-backend docs/plans/vatsim-build.md, Step 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INTERVAL_MS = 15_000
const TIMEOUT_MS = 10_000
const USER_AGENT = 'WingLog/dev-capture (+https://github.com/Catalyst4K/WingLog)'
const VATSIM_STATUS_URL = 'https://status.vatsim.net/status.json'
const VATSIM_FALLBACK_DATA_URL = 'https://data.vatsim.net/v3/vatsim-data.json'
const IVAO_URL = 'https://api.ivao.aero/v2/tracker/whazzup'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

async function vatsimDataUrl(): Promise<string> {
  try {
    const status = JSON.parse(await fetchText(VATSIM_STATUS_URL)) as { data?: { v3?: unknown[] } }
    const url = new URL(String(status.data?.v3?.[0]))
    if (url.protocol === 'https:' && url.hostname === 'data.vatsim.net') return url.toString()
  } catch (error) {
    console.warn('status.json unusable, using the fallback URL:', error)
  }
  return VATSIM_FALLBACK_DATA_URL
}

async function main(): Promise<void> {
  const [network, minutesArg] = process.argv.slice(2)
  const minutes = Number(minutesArg)
  if ((network !== 'vatsim' && network !== 'ivao') || !Number.isFinite(minutes) || minutes <= 0) {
    console.error('usage: online-capture.ts vatsim|ivao <minutes>')
    process.exit(1)
  }
  const dir = join('release', 'online-capture', network)
  mkdirSync(dir, { recursive: true })
  const url = network === 'vatsim' ? await vatsimDataUrl() : IVAO_URL
  const count = Math.max(1, Math.floor((minutes * 60_000) / INTERVAL_MS))
  for (let i = 0; i < count; i++) {
    const startedMs = Date.now()
    try {
      const body = await fetchText(url)
      const file = join(dir, `${new Date(startedMs).toISOString().replace(/[:.]/g, '-')}.json`)
      writeFileSync(file, body)
      console.log(`${i + 1}/${count} ${(body.length / 1e6).toFixed(2)} MB -> ${file}`)
    } catch (error) {
      console.error(`${i + 1}/${count} failed:`, error)
    }
    if (i < count - 1)
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, INTERVAL_MS - (Date.now() - startedMs))))
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
