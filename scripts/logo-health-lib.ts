/**
 * The pure parts of `npm run logo-health` (winglog-backend docs/plans/airline-logo-resilience.md step 4):
 * which codes to check and how to read the image service's answer.
 */
import { createHash } from 'node:crypto'

/** Where the app fetches an airline's logo from (src/renderer/src/airline-logo-src.ts). */
export const LOGO_URL_PREFIX = 'https://images.kiwi.com/airlines/32/'

export type LogoStatus =
  /** An image that isn't the service's stand-in. */
  | 'ok'
  /** The service has no logo for the code (a 404, or its stand-in image). */
  | 'missing'
  /** The service didn't answer properly: a server error, a timeout, a non-image. */
  | 'error'

export interface LogoAnswer {
  status: number
  contentType: string
  bytes: Uint8Array
}

/**
 * @param bytes An image's bytes.
 * @returns A short fingerprint, to spot the service's stand-in image.
 */
export function fingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

/**
 * Reads one answer from the image service.
 *
 * @param answer What came back.
 * @param standIn The fingerprint of the image the service returns for a code that doesn't exist, or null if it 404s instead.
 * @returns ok, missing or error.
 */
export function classifyLogo(answer: LogoAnswer, standIn: string | null): LogoStatus {
  if (answer.status === 404 || answer.status === 410) return 'missing'
  if (answer.status !== 200 || !answer.contentType.startsWith('image/')) return 'error'
  if (answer.bytes.length === 0) return 'error'
  return standIn !== null && fingerprint(answer.bytes) === standIn ? 'missing' : 'ok'
}

/**
 * The IATA codes in resources/airlines.csv (`name,icao,iata`), unique and upper-case.
 *
 * @param csv The file's text.
 * @returns The codes, in file order.
 */
export function iataCodesFromCsv(csv: string): string[] {
  const seen = new Set<string>()
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const cells = line.split(',')
    const iata = cells[cells.length - 1]?.trim().toUpperCase()
    if (iata && /^[A-Z0-9]{2}$/.test(iata)) seen.add(iata)
  }
  return [...seen]
}

export interface LogoHealth {
  checked: number
  ok: string[]
  missing: string[]
  error: string[]
}

/**
 * @param results Each code and what the service said.
 * @returns The codes grouped by outcome.
 */
export function summariseHealth(results: { iata: string; status: LogoStatus }[]): LogoHealth {
  return {
    checked: results.length,
    ok: results.filter((r) => r.status === 'ok').map((r) => r.iata),
    missing: results.filter((r) => r.status === 'missing').map((r) => r.iata),
    error: results.filter((r) => r.status === 'error').map((r) => r.iata)
  }
}
