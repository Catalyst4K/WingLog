import { describe, expect, it } from 'vitest'
import { extractOfpPdfUrl } from './ofp-pdf'

function ofpJson(files: unknown): string {
  return JSON.stringify({ files })
}

describe('extractOfpPdfUrl', () => {
  it('builds the PDF URL from a real-shaped OFP response', () => {
    const url = extractOfpPdfUrl(
      ofpJson({
        directory: 'https://www.simbrief.com/ofp/flightplans/',
        pdf: { name: 'PDF Document', link: 'VHHHZJSY_PDF_1788618462.pdf' }
      })
    )
    expect(url).toBe('https://www.simbrief.com/ofp/flightplans/VHHHZJSY_PDF_1788618462.pdf')
  })

  it('returns null for a null/missing ofpJson', () => {
    expect(extractOfpPdfUrl(null)).toBeNull()
  })

  it('returns null for unparseable JSON', () => {
    expect(extractOfpPdfUrl('{not json')).toBeNull()
  })

  it('returns null when files/pdf/link is missing', () => {
    expect(extractOfpPdfUrl(JSON.stringify({}))).toBeNull()
    expect(extractOfpPdfUrl(ofpJson({ directory: 'https://www.simbrief.com/ofp/flightplans/' }))).toBeNull()
    expect(extractOfpPdfUrl(ofpJson({ pdf: { link: 'x.pdf' } }))).toBeNull()
  })

  it('rejects a non-https scheme even if otherwise well-formed', () => {
    const url = extractOfpPdfUrl(
      ofpJson({ directory: 'file:///etc/', pdf: { link: 'passwd' } })
    )
    expect(url).toBeNull()
  })

  it('rejects a host other than SimBrief\'s own, even over https', () => {
    const url = extractOfpPdfUrl(
      ofpJson({ directory: 'https://evil.example.com/ofp/', pdf: { link: 'x.pdf' } })
    )
    expect(url).toBeNull()
  })

  it('rejects a malformed directory that fails URL parsing', () => {
    const url = extractOfpPdfUrl(ofpJson({ directory: 'not a url at all', pdf: { link: 'x.pdf' } }))
    expect(url).toBeNull()
  })
})
