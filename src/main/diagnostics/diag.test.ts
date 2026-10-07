import { describe, expect, it, vi } from 'vitest'

const fakeLog = vi.hoisted(() => {
  const instance = {
    transports: {
      console: { level: 'info' as string | false },
      file: {
        level: 'info' as string,
        maxSize: 0,
        resolvePathFn: undefined as unknown as (v: { libraryDefaultDir: string }) => string
      }
    },
    info: vi.fn()
  }
  return { instance, create: vi.fn(() => instance) }
})
vi.mock('electron-log/main', () => ({ default: { create: fakeLog.create } }))

import { createDiag, formatDiagLine, isDiagCategory, MAX_LINE_CHARS, openDiagLog } from './diag'

describe('formatDiagLine', () => {
  it('prefixes the category and appends data as JSON', () => {
    expect(formatDiagLine('phase', 'taxi -> takeoff', { groundSpeedMs: 41.2, onGround: true })).toBe(
      '[diag:phase] taxi -> takeoff {"groundSpeedMs":41.2,"onGround":true}'
    )
    expect(formatDiagLine('beyondatc', 'in', 'CommsState: ready')).toBe(
      '[diag:beyondatc] in "CommsState: ready"'
    )
    expect(formatDiagLine('capture', 'stopped')).toBe('[diag:capture] stopped')
  })

  it('says so rather than throwing when data cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatDiagLine('atc', 'boxes', circular)).toBe('[diag:atc] boxes (unserialisable data)')
  })

  it('cuts a huge line, such as a whole BeyondATC snapshot', () => {
    const line = formatDiagLine('beyondatc', 'in', 'x'.repeat(50_000))
    expect(line.length).toBeLessThan(MAX_LINE_CHARS + 20)
    expect(line.endsWith('… (cut)')).toBe(true)
  })
})

describe('createDiag', () => {
  it('does nothing in the normal build (no writer)', () => {
    expect(() => createDiag(null)('phase', 'anything', { a: 1 })).not.toThrow()
  })

  it('writes formatted lines in the dev build', () => {
    const lines: string[] = []
    createDiag((line) => lines.push(line))('gsx', 'out', '{"type":"command"}')
    expect(lines).toEqual(['[diag:gsx] out "{\\"type\\":\\"command\\"}"'])
  })

  it('never lets a failing write break the caller', () => {
    const diag = createDiag(() => {
      throw new Error('disk full')
    })
    expect(() => diag('phase', 'x')).not.toThrow()
  })
})

describe('isDiagCategory', () => {
  it('accepts only the known categories (the renderer IPC channel validates with it)', () => {
    expect(isDiagCategory('map')).toBe(true)
    expect(isDiagCategory('phase')).toBe(true)
    expect(isDiagCategory('MAP')).toBe(false)
    expect(isDiagCategory('map\n[diag:phase] forged')).toBe(false)
    expect(isDiagCategory(42)).toBe(false)
  })
})

describe('openDiagLog', () => {
  it('writes diag.log beside main.log, rotating at 10 MB, never to the console', () => {
    const write = openDiagLog()
    expect(fakeLog.create).toHaveBeenCalledWith({ logId: 'diag' })
    const { transports } = fakeLog.instance
    expect(transports.console.level).toBe(false)
    expect(transports.file.maxSize).toBe(10 * 1024 * 1024)
    expect(transports.file.resolvePathFn({ libraryDefaultDir: 'C:/logs' }).replace(/\\/g, '/')).toBe(
      'C:/logs/diag.log'
    )

    write('[diag:phase] x')
    expect(fakeLog.instance.info).toHaveBeenCalledWith('[diag:phase] x')
  })
})
