/** Where an airline's logo image comes from. */

/**
 * @param bundled Bundled logo URLs keyed by file path (`./airline-logos/KA.png`).
 * @param iata An airline's IATA code.
 * @returns The bundled logo URL for that code, or the image service's.
 */
export function logoSrc(bundled: Record<string, string>, iata: string): string {
  const code = iata.toUpperCase()
  return bundled[`./airline-logos/${code}.png`] ?? `https://images.kiwi.com/airlines/32/${code}.png`
}
