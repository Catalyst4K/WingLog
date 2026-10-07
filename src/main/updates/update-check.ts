/**
 * Asks GitHub whether a newer WingLog release is out (winglog-backend's
 * docs/plans/update-check.md, Part A; decided 2026-10-02 in its decisions.md). One GET of the
 * latest *published, non-prerelease* release — drafts never show up — sending nothing but
 * WingLog's own version in the User-Agent. The user downloads and installs it themselves,
 * same as today; this only tells them it exists.
 */

import { runLogged } from '../logging/run-logged'
import { EventEmitter } from 'node:events'
import type { UpdateRelease, UpdateStatus } from '@shared/ipc'
import { logger } from '../logging/logger'

/** GitHub's "latest release" endpoint for the public repo. One constant, https only. */
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/Catalyst4K/WingLog/releases/latest'
/** Every release page link must be on the public repo's releases, nowhere else. */
const RELEASE_PAGE_PREFIX = 'https://github.com/Catalyst4K/WingLog/releases/'
/** Release notes are shown as plain text; anything longer is cut, not rendered. */
const MAX_NOTES_LENGTH = 20_000

/** First check this long after launch, off the startup path. */
export const FIRST_CHECK_DELAY_MS = 30_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * "v1.4.0" or "1.4.0" → [1, 4, 0]; null for anything else (we never publish prereleases).
 *
 * @param tag A release tag.
 * @returns The version's parts, or null.
 */
export function parseVersion(tag: unknown): [number, number, number] | null {
  if (typeof tag !== 'string') return null
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(tag.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Positive when `a` is newer than `b`.
 *
 * @param a One version.
 * @param b The other.
 * @returns The difference.
 */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * GitHub's release JSON is third-party data: only the fields we use, each checked.
 *
 * @param json GitHub's release JSON.
 * @returns The release, or null for a draft, prerelease or malformed one.
 */
export function parseLatestRelease(json: unknown): UpdateRelease | null {
  if (typeof json !== 'object' || json === null) return null
  const r = json as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  const version = parseVersion(r.tag_name)
  if (!version) return null
  if (typeof r.html_url !== 'string' || !r.html_url.startsWith(RELEASE_PAGE_PREFIX)) return null
  return {
    version: version.join('.'),
    url: r.html_url,
    notes: typeof r.body === 'string' ? r.body.slice(0, MAX_NOTES_LENGTH) : '',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null
  }
}

export interface UpdateServiceOptions {
  currentVersion: string
  isEnabled: () => boolean
  getSkippedVersion: () => string | null
  setSkippedVersion: (version: string) => void
  fetchImpl?: typeof fetch
  url?: string
  log?: (message: string) => void
}

/**
 * Checks for a newer release on a schedule or on request, and keeps the status for Settings.
 */
export class UpdateService extends EventEmitter<{ status: [UpdateStatus] }> {
  private status: UpdateStatus
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private readonly fetchImpl: typeof fetch
  private readonly url: string
  private readonly log: (message: string) => void

  constructor(private readonly options: UpdateServiceOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.url = options.url ?? LATEST_RELEASE_URL
    this.log = options.log ?? ((message) => logger.info(`[updates] ${message}`))
    this.status = {
      state: 'idle',
      currentVersion: options.currentVersion,
      latest: null,
      checkedAt: null,
      skippedVersion: options.getSkippedVersion()
    }
  }

  /**
   * The status Settings → About shows.
   *
   * @returns The current status.
   */
  getStatus(): UpdateStatus {
    return this.status
  }

  /** The automatic schedule: a first check shortly after launch, then every few hours. Each
   *  tick re-reads the setting, so switching it off in Settings stops the next check. */
  start(): void {
    this.stop()
    this.firstTimer = setTimeout(() => runLogged('update check', this.scheduledCheck()), FIRST_CHECK_DELAY_MS)
    this.interval = setInterval(() => runLogged('update check', this.scheduledCheck()), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.interval) clearInterval(this.interval)
    this.firstTimer = null
    this.interval = null
  }

  /**
   * "Check now" in Settings → About, or a scheduled tick. Never throws.
   *
   * @returns The status afterwards.
   */
  async checkNow(): Promise<UpdateStatus> {
    this.setStatus({ ...this.status, state: 'checking' })
    try {
      const response = await this.fetchImpl(this.url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `WingLog/${this.options.currentVersion}`
        }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const latest = parseLatestRelease(await response.json())
      if (!latest) throw new Error('Unrecognised release data')
      const current = parseVersion(this.options.currentVersion)
      // parseLatestRelease only returns a release whose version parses.
      const latestVersion = parseVersion(latest.version)
      const newer = current !== null && latestVersion !== null && compareVersions(latestVersion, current) > 0
      this.setStatus({
        ...this.status,
        state: newer ? 'available' : 'upToDate',
        latest,
        checkedAt: new Date().toISOString()
      })
    } catch (error) {
      // Offline, rate-limited or a malformed reply: nothing for the user to act on.
      this.log(`check failed: ${error instanceof Error ? error.message : String(error)}`)
      this.setStatus({ ...this.status, state: 'error', checkedAt: new Date().toISOString() })
    }
    return this.status
  }

  /**
   * "Skip this version": no banner for it, only for something newer.
   *
   * @param version The version from the renderer; ignored unless it is the latest found.
   */
  skipVersion(version: unknown): void {
    if (typeof version !== 'string' || version !== this.status.latest?.version) return
    this.options.setSkippedVersion(version)
    this.setStatus({ ...this.status, skippedVersion: version })
  }

  /**
   * The validated release page, for shell.openExternal — never a URL from the renderer.
   *
   * @returns The URL, or null with no release found.
   */
  releaseUrl(): string | null {
    return this.status.latest?.url ?? null
  }

  private async scheduledCheck(): Promise<void> {
    if (this.options.isEnabled()) await this.checkNow()
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status
    this.emit('status', status)
  }
}
