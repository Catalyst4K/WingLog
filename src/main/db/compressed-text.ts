/**
 * A text column stored compressed: Drizzle's `customType` that compresses on write and decompresses on read, so the rest of the
 * code still sees a plain string. Used for the SimBrief OFP (`flight.ofp_json`), about 1.2 MB of JSON each, 70% of the database
 * (winglog-backend docs/plans/robustness/performance-and-storage.md).
 *
 * The column stays declared TEXT, so adding this changed no schema and needed no migration. SQLite is dynamically typed: a
 * compressed value is stored as a BLOB, a row written before this change is still TEXT, and the type read back says which is
 * which. Old rows stay readable as they are, and `compressStoredOfps` (ofp-storage.ts) converts them in the background.
 */
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { customType } from 'drizzle-orm/sqlite-core'

/** The first byte of a compressed value: which format follows, so another can be added later without guessing. */
const FORMAT_BROTLI = 1
/** Quality 6 gives about 10x on SimBrief JSON in about 20 ms; the highest levels cost seconds for a few percent. */
const BROTLI_QUALITY = 6

/**
 * @param text The text to store.
 * @returns A one-byte format marker followed by the Brotli-compressed UTF-8 bytes.
 */
export function compressText(text: string): Buffer {
  const packed = brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY }
  })
  return Buffer.concat([Buffer.from([FORMAT_BROTLI]), packed])
}

/**
 * @param stored What the column holds: text from before compression existed, or a compressed value.
 * @returns The original text.
 * @throws When a compressed value has a format this build doesn't know (written by a newer version).
 */
export function decompressText(stored: Buffer | Uint8Array | string): string {
  if (typeof stored === 'string') return stored
  if (stored[0] !== FORMAT_BROTLI) throw new Error(`Unknown compressed text format ${String(stored[0])}`)
  return brotliDecompressSync(stored.subarray(1)).toString('utf8')
}

/** A TEXT column holding compressed text (see the file header). */
export const compressedText = customType<{ data: string; driverData: Buffer | string }>({
  dataType: () => 'text',
  toDriver: (value) => compressText(value),
  fromDriver: (value) => decompressText(value)
})
