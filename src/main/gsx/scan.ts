import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { GsxServiceGroup } from '@shared/ipc'
import { parseReceiptFilename, type ParsedReceiptFilename } from './filename'
import { parseUsdAmount } from './money'
import { isNotailCandidate, matchesFlight, type FlightMatchWindow } from './matcher'

// The four service-group subfolders GSX writes receipts into, plus PriceLists which is a
// one-off user-triggered rate-card export with no JSON companion — not a receipt source
// at all (docs/gsx-notes.md, "PriceLists is not a data feed — ignore it").
const SERVICE_GROUP_DIRS: { dir: string; group: GsxServiceGroup }[] = [
  { dir: 'Catering', group: 'catering' },
  { dir: 'Fuel', group: 'fuel' },
  { dir: 'Handling', group: 'handling' },
  { dir: 'PassengerBus', group: 'passengerBus' }
]

export interface ReceiptFile {
  serviceGroup: GsxServiceGroup
  jsonPath: string
  htmlPath: string
  parsed: ParsedReceiptFilename
}

/** Resolves a bare `.json` path (e.g. one offered as a NOTAIL candidate and later
 *  manually attached) back into a ReceiptFile — the service group is inferred from the
 *  immediate parent directory name, same convention the folder scan itself relies on. */
export function receiptFileFromPath(jsonPath: string): ReceiptFile | null {
  const parsed = parseReceiptFilename(basename(jsonPath))
  if (!parsed) return null
  const dirName = basename(dirname(jsonPath))
  const match = SERVICE_GROUP_DIRS.find((d) => d.dir.toLowerCase() === dirName.toLowerCase())
  if (!match) return null
  return {
    serviceGroup: match.group,
    jsonPath,
    htmlPath: jsonPath.replace(/\.json$/i, '.html'),
    parsed
  }
}

async function listReceiptFiles(folderPath: string): Promise<ReceiptFile[]> {
  const files: ReceiptFile[] = []
  for (const { dir, group } of SERVICE_GROUP_DIRS) {
    let entries: string[]
    try {
      entries = await readdir(join(folderPath, dir))
    } catch {
      continue // folder missing entirely — not an error, just nothing from this group
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.json')) continue
      const parsed = parseReceiptFilename(entry)
      if (!parsed) continue
      files.push({
        serviceGroup: group,
        jsonPath: join(folderPath, dir, entry),
        htmlPath: join(folderPath, dir, entry.replace(/\.json$/i, '.html')),
        parsed
      })
    }
  }
  return files
}

/** The subset of a receipt JSON's fields this app actually stores — see docs/gsx-notes.md
 *  for the full real schema. Kept loose/untyped for anything not read here. */
interface RawGsxReceipt {
  operator?: unknown
  receiptId?: unknown
  dateText?: unknown
  total?: unknown
  logoDataUri?: unknown
  [key: string]: unknown
}

export interface StoredInvoiceInput {
  serviceGroup: GsxServiceGroup
  receiptId: string
  issuedUtc: string
  icao: string
  tail: string
  operator: string | null
  totalUsd: number | null
  totalText: string | null
  sourceHtmlPath: string
  /** The full receipt JSON, verbatim, minus logoDataUri (16-30 KB of repeated base64 PNG
   *  that nothing in WingLog renders — docs/gsx-notes.md's storage design). */
  receiptJson: string
}

/** Reads one receipt's JSON companion and shapes it for storage. Returns null on a read/
 *  parse failure (e.g. the file was deleted between listing and reading) rather than
 *  throwing and aborting an entire scan over one bad file. */
export async function readReceipt(file: ReceiptFile): Promise<StoredInvoiceInput | null> {
  let raw: RawGsxReceipt
  try {
    const text = await readFile(file.jsonPath, 'utf-8')
    raw = JSON.parse(text) as RawGsxReceipt
  } catch {
    return null
  }

  const withoutLogo: RawGsxReceipt = { ...raw }
  delete withoutLogo.logoDataUri
  const total = typeof raw.total === 'string' ? raw.total : null

  return {
    serviceGroup: file.serviceGroup,
    receiptId: typeof raw.receiptId === 'string' ? raw.receiptId : `${file.parsed.timestampUtc}-${file.parsed.icao}`,
    issuedUtc: file.parsed.timestampUtc,
    icao: file.parsed.icao,
    tail: file.parsed.tail,
    operator: typeof raw.operator === 'string' && raw.operator !== '' ? raw.operator : null,
    totalUsd: total ? parseUsdAmount(total) : null,
    totalText: total,
    sourceHtmlPath: file.htmlPath,
    receiptJson: JSON.stringify(withoutLogo)
  }
}

export interface GsxScanResult {
  matched: StoredInvoiceInput[]
  /** NOTAIL receipts within the flight's window/airport — not enough to auto-attach
   *  (docs/gsx-notes.md), offered separately so the user can attach one by hand. */
  notailCandidates: ReceiptFile[]
}

/** Scans every receipt subfolder under `folderPath` for ones matching `window`. Never
 *  throws on a missing/inaccessible folder — the caller (GSX-disabled or no folder set)
 *  is expected to skip calling this entirely, but a folder that's since been moved/deleted
 *  should degrade to "no receipts found", not crash the flight-completion path. */
export async function scanGsxFolder(folderPath: string, window: FlightMatchWindow): Promise<GsxScanResult> {
  const files = await listReceiptFiles(folderPath)
  const matchedFiles = files.filter((f) => matchesFlight(f.parsed, window))
  const notailCandidates = files.filter((f) => isNotailCandidate(f.parsed, window))

  const matched: StoredInvoiceInput[] = []
  for (const file of matchedFiles) {
    const invoice = await readReceipt(file)
    if (invoice) matched.push(invoice)
  }

  return { matched, notailCandidates }
}
