/**
 * Reads the two community releases the ATC areas are made from, from GitHub (winglog-backend docs/plans/atc-areas-auto-update.md). Used
 * by the app's own update and by `npm run data:atc-areas`, so both ask GitHub the same way. Everything that comes back is third-party
 * data: only `https:` addresses on GitHub's own hosts are fetched, each file is size-capped while it is read, and the release JSON is
 * checked field by field before anything in it is used.
 */
import { buildAreaFile } from './atc-areas-build'

export const VATSPY_REPO = 'vatsimnetwork/vatspy-data-project'
export const TRACON_REPO = 'vatsimnetwork/simaware-tracon-project'

/** Where the releases are read from, and which hosts a release file may be served from. */
export interface AreaSource {
  /** The API's address, without a trailing slash. */
  apiBase: string
  /** The hosts a release file may be served from. */
  assetHosts: ReadonlySet<string>
  /** True only for an end-to-end test's own server on this machine. */
  allowHttp: boolean
}

/** GitHub itself. */
export const REAL_AREA_SOURCE: AreaSource = {
  apiBase: 'https://api.github.com',
  assetHosts: new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
  ]),
  allowHttp: false
}

/** Each of the three files may be this big and no bigger (they are 0.9 to 2.2 MB today). */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 60_000

/**
 * The source, with the end-to-end test override honoured only in an unpackaged app (as the feed addresses are), so a released build can
 * never be pointed somewhere else by an environment variable.
 *
 * @param isPackaged Whether this is a packaged (released) app.
 * @param env The environment.
 * @returns Where to read the releases.
 */
export function resolveAreaSource(isPackaged: boolean, env: Record<string, string | undefined>): AreaSource {
  const override = env.WINGLOG_E2E_ATC_AREAS_URL
  if (isPackaged || !override) return REAL_AREA_SOURCE
  return { apiBase: override.replace(/\/+$/, ''), assetHosts: new Set(['127.0.0.1']), allowHttp: true }
}

/** One repository's latest release. */
export interface Release {
  tag: string
  /** Downloads one of the release's files, as text. */
  asset: (name: string) => Promise<string>
}

/** The two releases the file is made from. */
export interface Releases {
  vatspy: Release
  tracon: Release
}

/** What the app asks of the network: `fetch`, injected so tests need none. */
export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<Response>

/**
 * @param response A response.
 * @param maxBytes The most to read.
 * @returns The body as text.
 * @throws When the body is longer than `maxBytes`, without reading the rest.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error('File too large')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('File too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param version A release tag such as "v2610.1" or "v1.2.13".
 * @returns Its number parts, or null for anything else.
 */
export function tagParts(version: unknown): number[] | null {
  if (typeof version !== 'string') return null
  const match = /^v(\d{1,5}(?:\.\d{1,5}){1,3})$/.exec(version)
  return match?.[1] ? match[1].split('.').map(Number) : null
}

/**
 * @param a One release tag.
 * @param b Another.
 * @returns Positive when `a` is newer than `b`, negative when older, 0 when the same, null when either is not a release tag.
 */
export function compareTags(a: unknown, b: unknown): number | null {
  const left = tagParts(a)
  const right = tagParts(b)
  if (!left || !right) return null
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * @param source Where the releases are.
 * @param fetchImpl `fetch`.
 * @param userAgent What to call WingLog.
 * @param repo A GitHub repository, "owner/name".
 * @returns Its latest release: the tag and a way to download one of its files.
 * @throws When there is no release, or its JSON is not what GitHub sends.
 */
async function latestRelease(
  source: AreaSource,
  fetchImpl: FetchImpl,
  userAgent: string,
  repo: string
): Promise<Release> {
  const get = async (url: string, maxBytes: number): Promise<string> => {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return readCapped(response, maxBytes)
  }
  const info = JSON.parse(await get(`${source.apiBase}/repos/${repo}/releases/latest`, 1024 * 1024)) as {
    tag_name?: unknown
    draft?: unknown
    prerelease?: unknown
    assets?: { name?: unknown; browser_download_url?: unknown }[]
  }
  if (
    !tagParts(info.tag_name) ||
    info.draft === true ||
    info.prerelease === true ||
    !Array.isArray(info.assets)
  )
    throw new Error(`No release for ${repo}`)
  const tag = info.tag_name as string
  const assets = info.assets
  return {
    tag,
    asset: async (name) => {
      const found = assets.find((a) => a.name === name)
      const address =
        typeof found?.browser_download_url === 'string' ? safeUrl(found.browser_download_url) : null
      if (!address || !(address.protocol === 'https:' || (source.allowHttp && address.protocol === 'http:')))
        throw new Error(`${repo} ${tag} has no usable ${name}`)
      if (!source.assetHosts.has(address.hostname) || address.username || address.password)
        throw new Error(`${repo} ${tag}: ${name} is not on an allowed host`)
      return get(address.toString(), MAX_FILE_BYTES)
    }
  }
}

/**
 * @param value An address from third-party data.
 * @returns It as a URL, or null when it is not one.
 */
function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * @param source Where the releases are.
 * @param fetchImpl `fetch`.
 * @param userAgent What to call WingLog (the app's version).
 * @returns The latest release of each repository.
 */
export async function latestReleases(
  source: AreaSource,
  fetchImpl: FetchImpl,
  userAgent: string
): Promise<Releases> {
  return {
    vatspy: await latestRelease(source, fetchImpl, userAgent, VATSPY_REPO),
    tracon: await latestRelease(source, fetchImpl, userAgent, TRACON_REPO)
  }
}

/**
 * Downloads the three files of two releases and makes the area file out of them.
 *
 * @param releases The two releases.
 * @returns The area file's text.
 * @throws When a file cannot be read or is not shaped as the community's files are.
 */
export async function downloadAreaFile(releases: Releases): Promise<string> {
  const dat = await releases.vatspy.asset('VATSpy.dat')
  const boundaries = await releases.vatspy.asset('Boundaries.geojson')
  const tracon = await releases.tracon.asset('TRACONBoundaries.geojson')
  return buildAreaFile({
    dat,
    boundaries,
    tracon,
    vatspyTag: releases.vatspy.tag,
    traconTag: releases.tracon.tag
  })
}
