import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { qrMatrix } from './qr'

/** Whether a 7 x 7 finder pattern (dark ring, light ring, dark 3 x 3 centre) sits with its top-left corner at (row, col). */
function hasFinder(grid: boolean[][], row: number, col: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
      const dark = ring !== 2
      if (grid[row + r][col + c] !== dark) return false
    }
  }
  return true
}

/**
 * Draws the code as a scanner's camera would see it: black squares on white, `scale` pixels each, with the four-square quiet zone.
 *
 * @param grid The code.
 * @param scale Pixels per square.
 * @returns RGBA pixels and their size.
 */
function render(grid: boolean[][], scale: number): { data: Uint8ClampedArray; size: number } {
  const size = (grid.length + 8) * scale
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid.length; x++) {
      if (!grid[y][x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4
          data[at] = data[at + 1] = data[at + 2] = 0
        }
      }
    }
  }
  return { data, size }
}

describe('a QR code read back by a real decoder', () => {
  it.each([
    'http://192.168.1.136:8765/',
    'http://10.0.0.5:8790/',
    'http://172.16.254.253:65535/',
    'http://169.254.10.2:1024/'
  ])('reads as exactly %s', (url) => {
    const { data, size } = render(qrMatrix(url), 6)
    expect(jsQR(data, size, size)?.data).toBe(url)
  })

  it('still reads at the size and a blur-free small scale the Settings card uses', () => {
    const { data, size } = render(qrMatrix('http://192.168.1.136:8765/'), 3)
    expect(jsQR(data, size, size)?.data).toBe('http://192.168.1.136:8765/')
  })
})

describe('qrMatrix', () => {
  const url = 'http://192.168.1.136:8765/'

  it('is a square grid sized as a QR version (21 + 4 per step)', () => {
    const grid = qrMatrix(url)
    expect(grid.length).toBeGreaterThanOrEqual(21)
    expect((grid.length - 17) % 4).toBe(0)
    for (const row of grid) expect(row).toHaveLength(grid.length)
  })

  it('has the finder pattern a scanner locks on to in three corners, and not the fourth', () => {
    const grid = qrMatrix(url)
    const n = grid.length
    expect(hasFinder(grid, 0, 0)).toBe(true)
    expect(hasFinder(grid, 0, n - 7)).toBe(true)
    expect(hasFinder(grid, n - 7, 0)).toBe(true)
    expect(hasFinder(grid, n - 7, n - 7)).toBe(false)
  })

  it('has the alternating timing line between the finders', () => {
    const grid = qrMatrix(url)
    for (let i = 8; i < grid.length - 8; i++) {
      expect(grid[6][i]).toBe(i % 2 === 0)
      expect(grid[i][6]).toBe(i % 2 === 0)
    }
  })

  it('is the same for the same text and different for different text', () => {
    expect(qrMatrix(url)).toEqual(qrMatrix(url))
    expect(qrMatrix('http://192.168.1.137:8765/')).not.toEqual(qrMatrix(url))
  })

  it('grows to hold a longer address', () => {
    expect(qrMatrix(`http://192.168.100.200:8765/${'x'.repeat(80)}`).length).toBeGreaterThan(
      qrMatrix(url).length
    )
  })
})
