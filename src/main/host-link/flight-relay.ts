/**
 * What a client does with the buttons that change a flight: Fly, Start, Finish and Cancel are sent to the sim PC, which is where the sim is
 * (winglog-backend's docs/plans/multi-device.md, Part 3). The flight itself is planned here, in this computer's database; it is brought
 * level with the sim PC first so the sim PC has it, and named to it by uuid. A refusal comes back as an error the screen shows.
 */

import { getFlightUuidById } from '../db/flight-repo'
import type { WingLogDb } from '../db/client'

/** Asks the sim PC a lookup (`HostLink.query`). */
type Ask = (name: string, ...args: unknown[]) => Promise<unknown>

/** Brings the two databases level; false when the link is down or the sync failed. */
interface SyncNow {
  run(): Promise<boolean>
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
   * @param sync Brings this computer level with the sim PC.
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
    if (!this.target) throw new Error('Not connected to the sim PC')
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
    if (!(await sync.run())) throw new Error('Could not bring this flight to the sim PC: it is not connected')
    await ask(name, uuid)
  }
}
