import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FlightMatchWindow } from './matcher'
import { readReceipt, receiptFileFromPath, scanGsxFolder, type ReceiptFile } from './scan'

const WINDOW: FlightMatchWindow = {
  depIcao: 'EGLL',
  arrIcao: 'EGCC',
  registration: 'G-ABCD',
  windowStartUtc: '2026-09-06T12:00:00.000Z',
  windowEndUtc: '2026-09-06T13:00:00.000Z'
}

function writeReceipt(dir: string, filename: string, body: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), JSON.stringify(body), 'utf-8')
  writeFileSync(join(dir, filename.replace(/\.json$/, '.html')), '<html></html>', 'utf-8')
}

describe('gsx scan', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'winglog-gsx-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('receiptFileFromPath', () => {
    it('resolves a valid receipt path back into a ReceiptFile', () => {
      const jsonPath = join(root, 'Fuel', '20260906T121500Z_EGLL_G-ABCD.json')
      const result = receiptFileFromPath(jsonPath)
      expect(result).toEqual({
        serviceGroup: 'fuel',
        jsonPath,
        htmlPath: join(root, 'Fuel', '20260906T121500Z_EGLL_G-ABCD.html'),
        parsed: { timestampUtc: '2026-09-06T12:15:00Z', icao: 'EGLL', tail: 'G-ABCD' }
      })
    })

    it('returns null for a filename that does not match the GSX pattern', () => {
      expect(receiptFileFromPath(join(root, 'Fuel', 'not-a-receipt.json'))).toBeNull()
    })

    it('returns null when the parent directory is not a known service group', () => {
      const jsonPath = join(root, 'Unknown', '20260906T121500Z_EGLL_G-ABCD.json')
      expect(receiptFileFromPath(jsonPath)).toBeNull()
    })

    it('matches the service group directory case-insensitively', () => {
      const jsonPath = join(root, 'fuel', '20260906T121500Z_EGLL_G-ABCD.json')
      expect(receiptFileFromPath(jsonPath)?.serviceGroup).toBe('fuel')
    })
  })

  describe('readReceipt', () => {
    const file: ReceiptFile = {
      serviceGroup: 'fuel',
      jsonPath: '',
      htmlPath: '',
      parsed: { timestampUtc: '2026-09-06T12:15:00Z', icao: 'EGLL', tail: 'G-ABCD' }
    }

    it('reads and shapes a receipt, stripping the logo data URI', async () => {
      const jsonPath = join(root, 'receipt.json')
      writeFileSync(
        jsonPath,
        JSON.stringify({
          operator: 'Test Fuel Co',
          receiptId: 'RCPT-1',
          total: '£100.00 ~$ 123.45',
          logoDataUri: 'data:image/png;base64,AAAA'
        }),
        'utf-8'
      )

      const invoice = await readReceipt({ ...file, jsonPath, htmlPath: join(root, 'receipt.html') })
      expect(invoice).toMatchObject({
        serviceGroup: 'fuel',
        receiptId: 'RCPT-1',
        operator: 'Test Fuel Co',
        totalUsd: 123.45,
        totalText: '£100.00 ~$ 123.45'
      })
      expect(invoice?.receiptJson).not.toContain('logoDataUri')
    })

    it('falls back to a timestamp+icao receiptId when none is present', async () => {
      const jsonPath = join(root, 'receipt.json')
      writeFileSync(jsonPath, JSON.stringify({ total: '£8.00 ~$ 10.00' }), 'utf-8')
      const invoice = await readReceipt({ ...file, jsonPath, htmlPath: join(root, 'receipt.html') })
      expect(invoice?.receiptId).toBe('2026-09-06T12:15:00Z-EGLL')
    })

    it('treats a missing or empty operator as null', async () => {
      const jsonPath = join(root, 'receipt.json')
      writeFileSync(jsonPath, JSON.stringify({ operator: '' }), 'utf-8')
      const invoice = await readReceipt({ ...file, jsonPath, htmlPath: join(root, 'receipt.html') })
      expect(invoice?.operator).toBeNull()
    })

    it('treats a missing total as null rather than throwing', async () => {
      const jsonPath = join(root, 'receipt.json')
      writeFileSync(jsonPath, '{}', 'utf-8')
      const invoice = await readReceipt({ ...file, jsonPath, htmlPath: join(root, 'receipt.html') })
      expect(invoice?.totalUsd).toBeNull()
      expect(invoice?.totalText).toBeNull()
    })

    it('returns null when the file cannot be read', async () => {
      const invoice = await readReceipt({ ...file, jsonPath: join(root, 'missing.json'), htmlPath: join(root, 'missing.html') })
      expect(invoice).toBeNull()
    })

    it('returns null when the file is not valid JSON', async () => {
      const jsonPath = join(root, 'bad.json')
      writeFileSync(jsonPath, 'not json', 'utf-8')
      const invoice = await readReceipt({ ...file, jsonPath, htmlPath: join(root, 'bad.html') })
      expect(invoice).toBeNull()
    })
  })

  describe('scanGsxFolder', () => {
    it('returns empty results for a folder with none of the service-group subdirectories', async () => {
      const result = await scanGsxFolder(root, WINDOW)
      expect(result).toEqual({ matched: [], notailCandidates: [] })
    })

    it('finds a matching receipt and reads its JSON', async () => {
      writeReceipt(join(root, 'Fuel'), '20260906T121500Z_EGLL_G-ABCD.json', { total: '£40.00 ~$ 50.00' })

      const result = await scanGsxFolder(root, WINDOW)
      expect(result.matched).toHaveLength(1)
      expect(result.matched[0].totalUsd).toBe(50)
      expect(result.notailCandidates).toEqual([])
    })

    it('ignores non-json files and files that do not parse as receipts', async () => {
      mkdirSync(join(root, 'Fuel'), { recursive: true })
      writeFileSync(join(root, 'Fuel', 'readme.txt'), 'not a receipt', 'utf-8')
      writeFileSync(join(root, 'Fuel', 'unrelated.json'), '{}', 'utf-8')

      const result = await scanGsxFolder(root, WINDOW)
      expect(result.matched).toEqual([])
    })

    it('offers a NOTAIL receipt within the window as a candidate, not a match', async () => {
      writeReceipt(join(root, 'Handling'), '20260906T121500Z_EGLL_NOTAIL.json', {})

      const result = await scanGsxFolder(root, WINDOW)
      expect(result.matched).toEqual([])
      expect(result.notailCandidates).toHaveLength(1)
      expect(result.notailCandidates[0].parsed.tail).toBe('NOTAIL')
    })

    it('excludes a receipt for a different tail or outside the window', async () => {
      writeReceipt(join(root, 'Fuel'), '20260906T121500Z_EGLL_G-WRONG.json', {})
      writeReceipt(join(root, 'Fuel'), '20260101T000000Z_EGLL_G-ABCD.json', {})

      const result = await scanGsxFolder(root, WINDOW)
      expect(result.matched).toEqual([])
      expect(result.notailCandidates).toEqual([])
    })

    it('scans multiple service-group subdirectories independently', async () => {
      writeReceipt(join(root, 'Fuel'), '20260906T121500Z_EGLL_G-ABCD.json', { total: '£40.00 ~$ 50.00' })
      writeReceipt(join(root, 'Catering'), '20260906T122000Z_EGLL_G-ABCD.json', { total: '£16.00 ~$ 20.00' })

      const result = await scanGsxFolder(root, WINDOW)
      expect(result.matched.map((m) => m.serviceGroup).sort()).toEqual(['catering', 'fuel'])
    })
  })
})
