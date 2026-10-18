/**
 * Minimal CSV helpers shared by every vendored/imported CSV source in the app
 * (logbook-csv.ts, aircraft-lookup/icao-types.ts, airports/airport-search.ts) and the
 * Logbook/Fleet CSV export/import (logbook-portable.ts, aircraft-portable.ts). The vendored
 * OurAirports slice has quoted fields (e.g. `"Total RF Heliport"`), so this parser is RFC
 * 4180: quoted fields, "" as an escaped quote, commas and newlines inside quotes — a strict
 * superset of a plain comma-split, so quote-free sources behave as before.
 */

/**
 * RFC 4180 parse of a whole document. Quoted fields may contain commas, doubled quotes and
 * *newlines* (so an exported field with a line break round-trips); cells are trimmed and
 * blank lines dropped, matching what the original line-by-line parser did for the vendored
 * sources.
 *
 * @param text The whole document.
 * @returns Its rows, each a list of trimmed cells.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let cells: string[] = []
  let cur = ''
  let inQuotes = false
  const endCell = (): void => {
    cells.push(cur.trim())
    cur = ''
  }
  const endRow = (): void => {
    endCell()
    if (!(cells.length === 1 && cells[0] === '')) rows.push(cells)
    cells = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      endCell()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      cur += c
    }
  }
  // Last row with no trailing newline.
  if (cur !== '' || cells.length > 0) endRow()
  return rows
}

/** Quotes a field only when it must be (comma, quote, CR/LF, or edge whitespace that the
 *  parser would otherwise trim away). `null`/`undefined` become an empty field.
 *
 * @param value The cell.
 * @returns The cell as CSV text.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Serialises rows (header first) as RFC 4180 CSV with CRLF line endings — what
 *  spreadsheets expect.
 *
 * @param rows The rows, header first.
 * @returns The CSV text.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/**
 * Finds a column by name, ignoring case.
 *
 * @param header The header row.
 * @param name The column, in any case.
 * @returns Its index, or -1.
 */
export function columnIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
}
