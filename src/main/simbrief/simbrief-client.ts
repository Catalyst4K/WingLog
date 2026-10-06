/**
 * Fetches the pilot's latest SimBrief OFP. Parsing lives in src/shared/simbrief-ofp.ts, re-exported
 * here for existing importers.
 */
import { parseOfp, SimBriefError, type SimBriefOfp } from '@shared/simbrief-ofp'

export { optNum, optStr, parseOfp, parseStepClimbs, type SimBriefOfp, type SimBriefStepClimb } from '@shared/simbrief-ofp'

export async function fetchLatestOfp(username: string): Promise<SimBriefOfp> {
  const url = `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(username)}&json=1`
  const response = await fetch(url)
  const raw: unknown = await response.json().catch(() => undefined)

  if (!response.ok) {
    throw new SimBriefError(`SimBrief fetch failed (HTTP ${response.status}) for username "${username}"`)
  }
  return parseOfp(raw)
}
