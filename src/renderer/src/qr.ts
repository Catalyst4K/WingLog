/** A QR code for a short text, as a grid of dark and light squares. */

import qrcode from 'qrcode-generator'

/**
 * @param text What the code holds (here, the address a phone opens).
 * @returns The code as rows of squares, true for dark. Square, with the version chosen to fit the text and medium error correction, so a
 *   scuffed or glary screen still scans.
 */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, 'M')
  code.addData(text)
  code.make()
  const size = code.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => code.isDark(row, col))
  )
}
