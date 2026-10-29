/** A map popup built from text nodes only. */
import { Popup, type Map as MapLibreMap } from 'maplibre-gl'

/**
 * Opens a popup built from text nodes only: the lines came from a network feed, so none of it is ever parsed as HTML.
 *
 * @param map The map.
 * @param at Where the symbol was clicked.
 * @param lines The popup's lines; the first is the title.
 * @param maxWidth The popup's widest size, as CSS.
 */
export function openTextPopup(
  map: MapLibreMap,
  at: { lng: number; lat: number },
  lines: string[],
  maxWidth = '240px'
): void {
  const content = document.createElement('div')
  lines.forEach((line, index) => {
    const row = document.createElement('div')
    if (index === 0) row.style.fontWeight = '600'
    row.textContent = line
    content.appendChild(row)
  })
  new Popup({ closeButton: true, maxWidth }).setLngLat(at).setDOMContent(content).addTo(map)
}
