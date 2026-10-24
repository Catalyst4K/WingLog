/**
 * An error as one log line says it. An `AggregateError` (what a failed SimConnect connection throws) has no message, so the message alone
 * logged as nothing at all; the name always shows.
 *
 * @param error Whatever was thrown.
 * @returns "Name: message", just the name when there is no message, or the value as text when it isn't an `Error`.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.message ? `${error.name}: ${error.message}` : error.name
}
