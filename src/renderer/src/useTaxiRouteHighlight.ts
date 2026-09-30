import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { BeyondAtcTranscriptEntry } from '@shared/ipc'
import { parseTaxiRoute } from './taxiRouteParser'
import { TAXI_SOURCE_ID } from './useTaxiChartOverlay'

/**
 * Highlights the taxiway names from BeyondATC's most recent live taxi clearance on top of
 * the taxi chart overlay (flightdeck-backend's docs/plans/beyondatc-taxi-route-highlight.md —
 * the ATC-driven route half of Part 4, built on top of Part 4a's static chart). A second
 * `line` layer on the *same* `taxi-chart` source (useTaxiChartOverlay.ts), filtered to the
 * currently claimed taxiway names, rather than a separate fetch — the chart already has every
 * segment this needs.
 *
 * v1 limitation, deliberate (see taxiRouteParser.ts): this highlights every segment sharing a
 * claimed name, not just the specific stretch actually travelled — no pathfinding through the
 * taxi network graph. On a large airport with a repeated taxiway letter, this can highlight
 * more than the real route. A later revision could resolve this with real position/sequence
 * data; not attempted here.
 */

const HIGHLIGHT_LAYER_ID = 'taxi-chart-route-highlight'

function ensureHighlightLayer(map: MapLibreMap): void {
  if (map.getLayer(HIGHLIGHT_LAYER_ID)) return
  map.addLayer({
    id: HIGHLIGHT_LAYER_ID,
    type: 'line',
    source: TAXI_SOURCE_ID,
    layout: { visibility: 'none' },
    // Bright and thick against the base chart's muted, thin line (useTaxiChartOverlay.ts) —
    // meant to read as "your route," not just another taxiway.
    paint: { 'line-color': '#facc15', 'line-width': 3.5, 'line-opacity': 0.95 },
    filter: ['in', ['get', 'name'], ['literal', []]]
  })
}

export interface UseTaxiRouteHighlightArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only ever shown alongside the base taxi chart — highlighting a route on a hidden chart
   *  would be invisible and confusing once the chart is turned back on. Pass
   *  `taxiChart.enabled` from useTaxiChartOverlay. */
  enabled: boolean
}

/** Survives a FlightMap remount the same way useTaxiChartOverlay's rememberedEnabled does —
 *  a route parsed before a tab switch shouldn't just vanish on return. Cleared only by a
 *  genuinely new clearance, never automatically (v1 — see module doc comment above). */
let rememberedNames: string[] | null = null

export function useTaxiRouteHighlight({ mapRef, mapReady, enabled }: UseTaxiRouteHighlightArgs): void {
  const [names, setNames] = useState<string[] | null>(rememberedNames)
  const lastTs = useRef(0)
  // Whether this hook has itself called ensureHighlightLayer. Checked instead of calling
  // map.getLayer() unconditionally on every mount (App.tsx/LogbookView.tsx's own FlightMap
  // hosts use a simpler test fake that doesn't implement getLayer, since nothing needed it
  // there before — this hook must never touch it while the base chart has never been on).
  const createdRef = useRef(false)

  // Gated on `enabled` — same "nothing happens until the chart is switched on" discipline
  // useTaxiChartOverlay's own fetch effect follows, and it means a test never needs to stub
  // onBeyondAtcTranscript just because FlightMap mounted with the chart off (the common case
  // across this file's other describe blocks). A clearance that arrives before the chart is
  // first switched on is missed — an accepted v1 trade-off, not solved here.
  useEffect(() => {
    if (!enabled) return
    return window.winglog.onBeyondAtcTranscript((transcript: BeyondAtcTranscriptEntry[]) => {
      let latest: string[] | null = null
      for (const entry of transcript) {
        if (entry.speaker !== 'atc' || entry.ts <= lastTs.current) continue
        lastTs.current = entry.ts
        const route = parseTaxiRoute(entry.text)
        if (route) latest = route
      }
      if (latest) {
        rememberedNames = latest
        setNames(latest)
      }
    })
  }, [enabled])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (!enabled) {
      if (createdRef.current) map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', 'none')
      return
    }
    ensureHighlightLayer(map)
    createdRef.current = true
    const visible = names !== null && names.length > 0
    map.setLayoutProperty(HIGHLIGHT_LAYER_ID, 'visibility', visible ? 'visible' : 'none')
    if (visible) map.setFilter(HIGHLIGHT_LAYER_ID, ['in', ['get', 'name'], ['literal', names]])
  }, [mapRef, mapReady, enabled, names])
}
