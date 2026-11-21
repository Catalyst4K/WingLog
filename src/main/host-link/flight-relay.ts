/**
 * What a client does with the buttons that change a flight: Fly, Start, Finish and Cancel are sent to the sim PC, which is where the sim is
 * (winglog-backend's docs/plans/multi-device.md, Part 3). The flight itself is planned here, in this computer's database; it is brought
 * level with the sim PC first so the sim PC has it, and named to it by uuid. A refusal comes back as an error the screen shows.
 */

import { getFlightUuidById } from '../db/flight-repo'
import type { WingLogDb } from '../db/client'
import { t } from '../i18n'

/** Asks the sim PC a lookup (`HostLink.query`). */
type Ask = (name: string, ...args: unknown[]) => Promise<unknown>

/** Brings the two databases level; false when the link is down or the sync failed. */
interface SyncNow {
  run(): Promise<boolean>
  /** Whether the link to the sim PC is up. */
  connected(): boolean
  /** What to tell the pilot when the link is not up, from where it stands. */
  refusal(): string
}

/** The calls the tracking handlers make instead of acting on a flight themselves, when this computer is a client. */
export interface FlightRelayPort {
  fly(flightId: number): Promise<void>
  start(flightId: number): Promise<void>
  finish(): Promise<void>
  stop(): Promise<void>
  cancel(flightId: number): Promise<void>
}

/** Sends flight commands to the sim PC. */
export class FlightRelay implements FlightRelayPort {
  private target: { sync: SyncNow; ask: Ask } | null = null

  /** @param db This computer's database, which names a flight by its uuid. */
  constructor(private readonly db: WingLogDb) {}

  /**
   * Connects the relay to the link, once it exists.
   *
   * @param sync Brings this computer level with the sim PC, and says whether the link is up.
   * @param ask Asks the sim PC a lookup.
   */
  bind(sync: SyncNow, ask: Ask): void {
    this.target = { sync, ask }
  }

  fly(flightId: number): Promise<void> {
    return this.send('flight.fly', flightId)
  }

  start(flightId: number): Promise<void> {
    return this.send('flight.start', flightId)
  }

  async finish(): Promise<void> {
    await this.connected().ask('flight.finish')
  }

  async stop(): Promise<void> {
    await this.connected().ask('flight.stop')
  }

  cancel(flightId: number): Promise<void> {
    return this.send('flight.cancel', flightId)
  }

  /** @returns The link, or an error to show when there is none. */
  private connected(): { sync: SyncNow; ask: Ask } {
    if (!this.target) throw new Error(t('errors.simPcNotConnected'))
    return this.target
  }

  /**
   * Brings the sim PC level, so it has the flight, then names the flight to it.
   *
   * @param name The command.
   * @param flightId The flight, as this computer knows it.
   */
  private async send(name: string, flightId: number): Promise<void> {
    const { sync, ask } = this.connected()
    const uuid = getFlightUuidById(this.db, flightId)
    if (!uuid) throw new Error('Unknown flight')
    if (!sync.connected()) throw new Error(sync.refusal())
    // A failed sync with the link up when it ended (the two WingLogs are different versions, say) is not a reconnect to wait for. A link
    // that dropped and came back during the sync reads the same, which is fair: the sync did fail, and trying again is right.
    if (!(await sync.run())) {
      throw new Error(sync.connected() ? t('errors.simPcSyncFailed') : sync.refusal())
    }
    await ask(name, uuid)
  }
}
