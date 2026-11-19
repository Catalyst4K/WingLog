/** Keeps what a device on the network can cause from filling the log. */

/**
 * @param loggedAt When each kind of line was last written, in milliseconds; this records `now` for `key` when the line is due.
 * @param key What the line is about.
 * @param now The time, in milliseconds.
 * @param intervalMs The least time between two lines of the same kind, in milliseconds.
 * @returns True when the line should be written now: none of that kind was written within the interval.
 */
export function dueForLog(
  loggedAt: Map<string, number>,
  key: string,
  now: number,
  intervalMs: number
): boolean {
  const last = loggedAt.get(key)
  if (last !== undefined && now - last < intervalMs) return false
  loggedAt.set(key, now)
  return true
}
