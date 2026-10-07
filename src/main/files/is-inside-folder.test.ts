import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInsideFolder } from './is-inside-folder'

const GSX = resolve('C:/Users/pilot/AppData/Roaming/Virtuali/GSX/MSFS/receipts')

describe('isInsideFolder', () => {
  it('accepts a file anywhere under the folder', () => {
    expect(isInsideFolder(GSX, join(GSX, 'Fuel', '20260906T121500Z_EGLL_G-ABCD.json'))).toBe(true)
    expect(isInsideFolder(GSX + '/', join(GSX, 'r.json'))).toBe(true)
  })

  it('refuses the folder itself, a way out through "..", a sibling with the same prefix, and elsewhere', () => {
    expect(isInsideFolder(GSX, GSX)).toBe(false)
    expect(isInsideFolder(GSX, join(GSX, 'Fuel', '..', '..', 'secrets.json'))).toBe(false)
    expect(isInsideFolder(GSX, GSX + '-backup/r.json')).toBe(false)
    expect(isInsideFolder(GSX, resolve('C:/Windows/System32/calc.exe'))).toBe(false)
  })
})
