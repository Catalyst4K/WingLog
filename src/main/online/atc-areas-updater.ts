/**
 * Keeps the ATC coverage areas current without a release (winglog-backend docs/plans/atc-areas-auto-update.md). The areas bundled with
 * WingLog are the floor; once a week, while an online network is chosen, the app asks GitHub whether the VAT-Spy or SimAware TRACON
 * project has a newer release, and if so makes its own copy in WingLog's data folder with the same conversion as the release script. The
 * newer of the two is the one in use, and any failure leaves what was in use.
 */
import type { AtcAreasCheck, AtcAreasStatus } from '@shared/ipc'
import { compareTags, tagParts, type Releases } from './atc-areas-download'
import { parseAreaData, type AreaData } from './atc-areas'

/** First check this long after launch, off the startup path. */
export const FIRST_CHECK_DELAY_MS = 60_000
/** How often to see whether a check is due. */
export const TICK_MS = 24 * 60 * 60 * 1000
/** A successful check is not repeated for this long (Check now ignores it). */
export const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000

/** What a downloaded file must hold before it replaces anything: a tenth of nothing is not an update. */
const MIN_AREAS = 100

/** What the updater needs from the app: all of it injected, so a test needs no network, disk or database. */
export interface AtcAreasUpdaterDeps {
  /** The areas bundled with this version. */
  bundled: () => AreaData | null
  /** The copy the app keeps in its data folder. */
  file: { read: () => string | null; write: (text: string) => void }
  settings: {
    auto: () => boolean
    setAuto: (on: boolean) => void
    checkedAt: () => string | null
    setCheckedAt: (iso: string) => void
  }
  /** Whether a network is chosen: with none, no request is ever made. */
  networkChosen: () => boolean
  /** The latest release of each project, from GitHub. */
  latestReleases: () => Promise<Releases>
  /** Makes the area file's text out of two releases. */
  download: (releases: Releases) => Promise<string>
  now: () => Date
  timers: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
  log: { info: (message: string) => void }
}

/** The releases a set of areas came from, and where they were read from. */
interface InUse {
  data: AreaData
  source: 'bundled' | 'downloaded'
}

/**
 * @param data Areas read from a file.
 * @param held The areas already in use, when there are any.
 * @returns Whether they are plausible: enough of each kind, and not far fewer than what is in use.
 */
function plausible(data: AreaData, held: AreaData | null): boolean {
  const floor = (heldCount: number | undefined): number => Math.max(MIN_AREAS, (heldCount ?? 0) / 2)
  return data.firs.size >= floor(held?.firs.size) && data.approaches.size >= floor(held?.approaches.size)
}

/**
 * @param candidate One release tag of the areas on offer.
 * @param held The same project's tag in the areas in use.
 * @returns How far ahead the candidate is (0 when level, negative when behind); null when the candidate is not a release tag. A held
 *   tag that cannot be read counts as behind, so it is replaced.
 */
function ahead(candidate: string, held: string): number | null {
  return tagParts(candidate) === null ? null : (compareTags(candidate, held) ?? 1)
}

/**
 * @param candidate Areas on offer: from the data folder, or just downloaded.
 * @param held The areas to beat.
 * @returns Whether the candidate is the newer: both of its releases are real tags and neither is older, and one is newer.
 */
function newerThan(candidate: AreaData, held: AreaData): boolean {
  const vatspy = ahead(candidate.sources.vatspy, held.sources.vatspy)
  const tracon = ahead(candidate.sources.tracon, held.sources.tracon)
  return vatspy !== null && tracon !== null && vatspy >= 0 && tracon >= 0 && vatspy + tracon > 0
}

/** The ATC areas in use, and the weekly look for newer ones. */
export class AtcAreasUpdater {
  private inUse: InUse | null | undefined
  private checking: Promise<AtcAreasCheck> | null = null
  private timer: unknown = null

  /**
   * @param deps The bundled areas, the data-folder copy, the settings, the network and the clock.
   */
  constructor(private readonly deps: AtcAreasUpdaterDeps) {}

  /**
   * @returns The areas in use: the downloaded copy when it is newer than the one bundled with this version, else the bundled one. Read
   *   once, and again after an update.
   */
  private choose(): InUse | null {
    if (this.inUse === undefined) {
      const bundled = this.deps.bundled()
      const text = this.deps.file.read()
      const downloaded = text === null ? null : parseAreaData(text)
      if (downloaded && plausible(downloaded, bundled) && (!bundled || newerThan(downloaded, bundled)))
        this.inUse = { data: downloaded, source: 'downloaded' }
      else this.inUse = bundled ? { data: bundled, source: 'bundled' } : null
    }
    return this.inUse
  }

  /**
   * @returns The areas the map draws now, or null when none can be read.
   */
  current = (): AreaData | null => this.choose()?.data ?? null

  /**
   * @returns What Settings shows: the switch, the releases in use, where they came from and when GitHub was last asked.
   */
  status(): AtcAreasStatus {
    const use = this.choose()
    return {
      auto: this.deps.settings.auto(),
      source: use?.source ?? 'bundled',
      vatspy: use?.data.sources.vatspy ?? '',
      tracon: use?.data.sources.tracon ?? '',
      checkedAt: this.deps.settings.checkedAt()
    }
  }

  /**
   * @param on Whether the app should check for newer areas by itself.
   * @returns The status after the change.
   */
  setAuto(on: boolean): AtcAreasStatus {
    this.deps.settings.setAuto(on)
    return this.status()
  }

  /**
   * @returns Whether a scheduled check is due: switched on, a network chosen, and none for a week.
   */
  private due(): boolean {
    if (!this.deps.settings.auto() || !this.deps.networkChosen()) return false
    const last = Date.parse(this.deps.settings.checkedAt() ?? '')
    return !Number.isFinite(last) || this.deps.now().getTime() - last >= CHECK_EVERY_MS
  }

  /**
   * Asks GitHub whether a newer release is out, and if so replaces the areas in use. Never throws: a failure is logged and leaves what
   * was in use.
   *
   * @param force True for Check now, which ignores the switch, the week, and whether a network is chosen.
   * @returns What happened, and the status after it.
   */
  check(force: boolean): Promise<AtcAreasCheck> {
    if (this.checking) return this.checking
    if (!force && !this.due()) return Promise.resolve({ outcome: 'skipped', status: this.status() })
    this.checking = this.run().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async run(): Promise<AtcAreasCheck> {
    try {
      const releases = await this.deps.latestReleases()
      const held = this.choose()?.data ?? null
      const newer =
        !held ||
        (compareTags(releases.vatspy.tag, held.sources.vatspy) ?? 1) > 0 ||
        (compareTags(releases.tracon.tag, held.sources.tracon) ?? 1) > 0
      const outcome = newer ? await this.replace(releases, held) : 'current'
      this.deps.settings.setCheckedAt(this.deps.now().toISOString())
      return { outcome, status: this.status() }
    } catch (error) {
      this.deps.log.info(`[atc-areas] not updated: ${String(error)}`)
      return { outcome: 'failed', status: this.status() }
    }
  }

  /**
   * @param releases The two releases, one at least newer than what is in use.
   * @param held What is in use.
   * @returns "updated", or "current" when what came down was not usable or not newer (nothing is replaced).
   */
  private async replace(releases: Releases, held: AreaData | null): Promise<'updated' | 'current'> {
    const text = await this.deps.download(releases)
    const data = parseAreaData(text)
    if (!data || !plausible(data, held)) throw new Error('The downloaded areas are not usable')
    if (held && !newerThan(data, held)) return 'current'
    this.deps.file.write(text)
    this.inUse = { data, source: 'downloaded' }
    this.deps.log.info(`[atc-areas] updated to VAT-Spy ${data.sources.vatspy}, TRACON ${data.sources.tracon}`)
    return 'updated'
  }

  /**
   * Starts the schedule: a first look a minute after launch, then daily. A look only checks when one is due.
   */
  start(): void {
    const tick = (): void => {
      // The next look is set first, so nothing a look does can end the schedule.
      this.timer = this.deps.timers.set(tick, TICK_MS)
      Promise.resolve()
        .then(() => this.check(false))
        .catch((error: unknown) => this.deps.log.info(`[atc-areas] check failed: ${String(error)}`))
    }
    this.timer = this.deps.timers.set(tick, FIRST_CHECK_DELAY_MS)
  }

  /**
   * Stops the schedule.
   */
  stop(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer)
    this.timer = null
  }
}
