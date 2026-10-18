/** The pairing code a scanned QR code carries in the page's address: `http://192.168.1.136:8765/#code=482913`. */

/**
 * @param hash The page address's fragment, such as `#code=482913`.
 * @returns The six-digit code, or null when there is not exactly one in the fragment.
 */
export function codeFromHash(hash: string): string | null {
  const match = /^#code=(\d{6})$/.exec(hash)
  return match ? match[1] : null
}
