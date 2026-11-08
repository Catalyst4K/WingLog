/**
 * The SimBrief OFP on the wire. It is stored compressed (`compressed-text.ts`), about 1.2 MB of JSON down to about 330 KB, but a sync row
 * carries the decompressed text escaped inside a JSON string, which made the largest flights 3.5 MB: over the Worker's 1.9 MB row limit,
 * so 42 of the PC's 216 flights never synced (winglog-backend docs/plans/sync-cursors.md). The row now carries the compressed bytes as
 * base64 in `ofpJsonZ` (about 440 KB for the largest), and the receiving side unpacks it before writing, so the database never holds anything new.
 */

import { compressText, decompressText } from '../db/compressed-text'

/** The most an OFP may unpack to: well over any real one (about 1.2 MB), well under a size that could hurt the app. */
const MAX_OFP_BYTES = 32 * 1024 * 1024

/**
 * @param ofpJson A flight's OFP as text, or null.
 * @returns The compressed bytes as base64, or null for no OFP.
 */
export function ofpToWire(ofpJson: string | null): string | null {
  return ofpJson === null ? null : compressText(ofpJson).toString('base64')
}

/**
 * @param data A pulled flight's fields.
 * @returns The OFP field to write, `{}` when the row has no `ofpJsonZ` (a row from before it existed carries a plain `ofpJson`, which is
 *   applied as it always was), or the reason the OFP could not be read.
 */
export function ofpFromWire(
  data: Record<string, unknown>
): { ok: true; fields: { ofpJson?: string | null } } | { ok: false; error: string } {
  const packed = data.ofpJsonZ
  if (packed === undefined) return { ok: true, fields: {} }
  if (packed === null) return { ok: true, fields: { ofpJson: null } }
  if (typeof packed !== 'string') return { ok: false, error: 'unreadable OFP' }
  try {
    return { ok: true, fields: { ofpJson: decompressText(Buffer.from(packed, 'base64'), MAX_OFP_BYTES) } }
  } catch {
    return { ok: false, error: 'unreadable OFP' }
  }
}
