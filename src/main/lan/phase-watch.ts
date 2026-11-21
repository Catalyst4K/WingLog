/** Notices when the tracked points a LAN server broadcasts move on to a new phase. */

/** Remembers the phase of the last tracked point seen. */
export class PhaseWatch {
  private last: unknown = null

  /**
   * @param phase The phase of the point that has just been broadcast.
   * @returns True when it differs from the point before (and for the first point).
   */
  changed(phase: unknown): boolean {
    const changed = phase !== this.last
    this.last = phase
    return changed
  }
}
