/**
 * GSX writes every receipt as an `.html` + `.json` pair sharing one filename
 * (docs/gsx-notes.md): `<ISO-8601 basic UTC timestamp>_<airport ICAO>_<tail>.json`, e.g.
 * `20260901T111457Z_EGLL_G-XWBS.json`. All three matching keys — when, where, which
 * aircraft — are in the filename itself, so candidate receipts for a flight can be found
 * from a directory listing alone, with no file reads. Only matched filenames need their
 * JSON opened.
 */
export interface ParsedReceiptFilename {
  timestampUtc: string
  icao: string
  /** The literal string "NOTAIL" when GSX had no tail assigned yet — a real, confirmed
   *  occurrence (docs/gsx-notes.md), not a hypothetical to guard against. */
  tail: string
}

const FILENAME_PATTERN = /^(\d{8}T\d{6}Z)_([A-Za-z0-9]{4})_(.+)$/

/**
 * Reads a receipt's file name.
 *
 * @param filename A receipt's file name.
 * @returns Its time, airport and tail, or null for any other file.
 */
export function parseReceiptFilename(filename: string): ParsedReceiptFilename | null {
  const basename = filename.replace(/\.(json|html)$/i, '')
  const match = FILENAME_PATTERN.exec(basename)
  if (!match) return null

  const [, basicTimestamp, icao, tail] = match
  const iso =
    `${basicTimestamp.slice(0, 4)}-${basicTimestamp.slice(4, 6)}-${basicTimestamp.slice(6, 8)}` +
    `T${basicTimestamp.slice(9, 11)}:${basicTimestamp.slice(11, 13)}:${basicTimestamp.slice(13, 15)}Z`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null

  return { timestampUtc: iso, icao: icao.toUpperCase(), tail }
}
