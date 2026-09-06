import { optStr } from './simbrief-client'

// SimBrief's own PDF host, confirmed live 2026-09-06 (docs/simbrief-notes.md): the
// generated file resolves with a plain keyless GET, no signing needed. Pinned here as a
// second check beyond "is this https" — files.directory/files.pdf.link are themselves
// external data, so without this a compromised or malformed OFP response could redirect
// shell.openExternal to an arbitrary https destination instead of just failing closed.
const SIMBRIEF_PDF_HOST = 'www.simbrief.com'

/**
 * Extracts the OFP's PDF URL from its raw stored JSON, if present and safe to open.
 * SimBrief's response already embeds this directly (files.directory + files.pdf.link) —
 * no separate fetch, no signing, unlike OFP generation itself. Defensive throughout:
 * this is external, third-party data, so anything missing or malformed degrades to null
 * rather than throwing, per CLAUDE.md's external-data rule.
 */
export function extractOfpPdfUrl(ofpJsonRaw: string | null): string | null {
  if (!ofpJsonRaw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(ofpJsonRaw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const files = (parsed as Record<string, unknown>).files
  if (typeof files !== 'object' || files === null) return null
  const directory = optStr((files as Record<string, unknown>).directory)

  const pdf = (files as Record<string, unknown>).pdf
  const link = typeof pdf === 'object' && pdf !== null ? optStr((pdf as Record<string, unknown>).link) : null
  if (!directory || !link) return null

  let url: URL
  try {
    url = new URL(link, directory)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== SIMBRIEF_PDF_HOST) return null
  return url.toString()
}
