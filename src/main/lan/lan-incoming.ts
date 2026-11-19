/** What a device may send the second-screen server, and how a message from one is read (it is not trusted). */

/** What a device may send. Anything else is dropped. */
export type Incoming =
  | { t: 'pair'; code: unknown; name?: unknown; kind?: unknown }
  | { t: 'hello'; token: unknown }
  | { t: 'cmd'; name: unknown; args: unknown }
  | { t: 'query'; id: unknown; name: unknown; args: unknown }
  | { t: 'report'; code: unknown; detail?: unknown }

/**
 * @param name A lookup's name as a device sent it.
 * @returns A short, safe version of it for the log: a device is not trusted to write what it likes there.
 */
export function logName(name: unknown): string {
  return typeof name === 'string' ? `"${name.slice(0, 40).replace(/[^\w.:-]/g, '?')}"` : '(not a name)'
}

/**
 * @param text A message as a device sent it.
 * @returns The message when it is one of the kinds a device may send, otherwise null. Never throws.
 */
export function parseIncoming(text: string): Incoming | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.t === 'pair') return { t: 'pair', code: record.code, name: record.name, kind: record.kind }
  if (record.t === 'hello') return { t: 'hello', token: record.token }
  if (record.t === 'cmd') return { t: 'cmd', name: record.name, args: record.args }
  if (record.t === 'query') return { t: 'query', id: record.id, name: record.name, args: record.args }
  if (record.t === 'report') return { t: 'report', code: record.code, detail: record.detail }
  return null
}
