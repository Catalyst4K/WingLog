/**
 * The Track map's traffic layers (winglog-backend docs/plans/vatsim-build.md, Steps 1d and 4b): the chosen network's aircraft near the pilot
 * (amber) and the sim's own aircraft (teal), as symbols pointing their heading, on the PC and the phone alike (both give FlightMap a
 * LiveClient).
 *
 * Main decides whether each layer draws (`trafficLayers`) and what is on it (`networkTraffic`, `simTraffic`); this hook only draws. Nothing is added to
 * the map until the layer first draws, and switching off hides the layers rather than removing them. Aircraft glide along their heading
 * between refreshes, once a second, timed from when this screen received the payload.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  Popup,
  type GeoJSONSourceSpecification,
  type Map as MapLibreMap,
  type MapGeoJSONFeature
} from 'maplibre-gl'
import { useTranslation } from 'react-i18next'
import type { NetworkTraffic, SimTraffic, TrafficAircraft, TrafficLayers } from '@shared/ipc'
import { useLiveClient } from './live/LiveClient'
import { reportError } from './report-error'
import { setSourceData } from './map-source'
import { addTrafficIcon, TRAFFIC_ICON_ID } from './flight-map/traffic-icon'
import { popupLines, trafficFeatures, type TrafficFeatureProperties } from './flight-map/traffic-features'

/** How often the aircraft are moved on, milliseconds. A source update per frame would cost more than it shows. */
export const GLIDE_INTERVAL_MS = 1000

/** How one traffic layer looks: its source, its colour and the colour of its labels in each theme. */
interface LayerStyle {
  sourceId: string
  color: string
  labelLight: string
  labelDark: string
}

/** The network's colour: amber, which contrasts with the own aircraft's blue in both themes. */
const NETWORK_STYLE: LayerStyle = {
  sourceId: 'network-traffic',
  color: '#f59f00',
  labelLight: '#7a4a00',
  labelDark: '#ffd8a8'
}

/** The sim's own traffic: teal, which is told apart from the network's amber and the own aircraft's blue. */
const SIM_STYLE: LayerStyle = {
  sourceId: 'sim-traffic',
  color: '#12b886',
  labelLight: '#087f5b',
  labelDark: '#96f2d7'
}

const airLayerId = (style: LayerStyle): string => `${style.sourceId}-air`
const groundLayerId = (style: LayerStyle): string => `${style.sourceId}-ground`

/** Zoom from which an airborne aircraft carries its callsign, and a ground one (they crowd airports). */
const AIR_LABEL_MINZOOM = 7
const GROUND_LABEL_MINZOOM = 13

/** Icon scale on screen: an aircraft on the ground is smaller and dimmer. */
const AIR_ICON_SIZE = 0.8
const GROUND_ICON_SIZE = 0.55
const GROUND_OPACITY = 0.55

/** What a GeoJSON source accepts as data. */
type GeoData = GeoJSONSourceSpecification['data']

/** What the overlay hands the map's controls and pills. */
export interface NetworkTrafficOverlay {
  layers: TrafficLayers | null
  traffic: NetworkTraffic | null
  simTraffic: SimTraffic | null
}

export interface UseNetworkTrafficOverlayArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  /** Only a live map shows traffic: a finished flight has no "now". */
  live: boolean
}

/**
 * Adds the source, the icon and the two symbol layers (airborne and on the ground) once, and the click handlers that open a popup.
 *
 * @param map The map.
 * @param style The layer's source, colour and label colours.
 * @param popupText Builds the popup's lines for a clicked symbol.
 */
function ensureTrafficLayers(
  map: MapLibreMap,
  style: LayerStyle,
  popupText: (properties: TrafficFeatureProperties) => string[]
): void {
  const { sourceId } = style
  if (map.getSource(sourceId)) return
  addTrafficIcon(map)
  map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const dark = document.documentElement.classList.contains('dark')
  const textPaint = {
    'text-color': dark ? style.labelDark : style.labelLight,
    'text-halo-color': dark ? '#0b0f14' : '#ffffff',
    'text-halo-width': 1.2
  }
  // A layer's minzoom would hide the icon as well, so the label is faded out by zoom inside its text size instead.
  const layout = (iconSize: number, labelMinzoom: number): Record<string, unknown> => ({
    'icon-image': TRAFFIC_ICON_ID,
    'icon-size': iconSize,
    'icon-rotate': ['get', 'headingDeg'],
    'icon-rotation-alignment': 'map',
    'icon-allow-overlap': true,
    'text-field': ['get', 'callsign'],
    'text-size': ['step', ['zoom'], 0, labelMinzoom, 10],
    'text-offset': [0, 1.1],
    'text-anchor': 'top',
    'text-optional': true
  })
  map.addLayer({
    id: airLayerId(style),
    type: 'symbol',
    source: sourceId,
    filter: ['!', ['get', 'onGround']],
    layout: layout(AIR_ICON_SIZE, AIR_LABEL_MINZOOM) as never,
    paint: { 'icon-color': style.color, ...textPaint }
  })
  map.addLayer({
    id: groundLayerId(style),
    type: 'symbol',
    source: sourceId,
    filter: ['get', 'onGround'],
    layout: layout(GROUND_ICON_SIZE, GROUND_LABEL_MINZOOM) as never,
    paint: {
      'icon-color': style.color,
      'icon-opacity': GROUND_OPACITY,
      'text-opacity': GROUND_OPACITY,
      ...textPaint
    }
  })
  for (const id of [airLayerId(style), groundLayerId(style)]) {
    map.on('click', id, (event) => {
      const feature: MapGeoJSONFeature | undefined = event.features?.[0]
      if (!feature) return
      openPopup(map, event.lngLat, popupText(feature.properties as TrafficFeatureProperties))
    })
    // The canvas's own cursor beats the container's (the grab hand, or the arrow while panning is locked).
    map.on('mouseenter', id, () => {
      map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', id, () => {
      map.getCanvas().style.cursor = ''
    })
  }
}

/**
 * Opens a popup built from text nodes only: the lines came from a network feed, so none of it is ever parsed as HTML.
 *
 * @param map The map.
 * @param at Where the symbol was clicked.
 * @param lines The popup's lines.
 */
function openPopup(map: MapLibreMap, at: { lng: number; lat: number }, lines: string[]): void {
  const content = document.createElement('div')
  lines.forEach((line, index) => {
    const row = document.createElement('div')
    if (index === 0) row.style.fontWeight = '600'
    row.textContent = line
    content.appendChild(row)
  })
  new Popup({ closeButton: true, maxWidth: '240px' }).setLngLat(at).setDOMContent(content).addTo(map)
}

/**
 * Shows or hides the layers.
 *
 * @param map The map.
 * @param style The layer's source, colour and label colours.
 * @param visible Whether they should be seen.
 */
function setVisible(map: MapLibreMap, style: LayerStyle, visible: boolean): void {
  for (const id of [airLayerId(style), groundLayerId(style)])
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

/** What {@link useDrawnLayer} needs. */
interface DrawnLayerArgs {
  mapRef: MutableRefObject<MapLibreMap | null>
  mapReady: boolean
  style: LayerStyle
  /** The aircraft to draw, or null while the layer should not be seen. */
  aircraft: TrafficAircraft[] | null
  /** When this screen received the aircraft (its own clock), which the glide counts from. */
  receivedAtMsRef: MutableRefObject<number>
  onGroundText: string
}

/**
 * Draws one traffic layer: creates it the first time there is something to show, hides it when there is not, and moves the aircraft on
 * once a second between refreshes.
 *
 * @param args The map, the layer's look, the aircraft (null to hide) and when they were received.
 */
function useDrawnLayer({
  mapRef,
  mapReady,
  style,
  aircraft,
  receivedAtMsRef,
  onGroundText
}: DrawnLayerArgs): void {
  const createdRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    if (aircraft === null) {
      if (createdRef.current) setVisible(map, style, false)
      return
    }
    if (!createdRef.current) {
      ensureTrafficLayers(map, style, (properties) => popupLines(properties, onGroundText))
      createdRef.current = true
    }
    setVisible(map, style, true)
    const draw = (): void => {
      const seconds = (performance.now() - receivedAtMsRef.current) / 1000
      setSourceData(map, style.sourceId, trafficFeatures(aircraft, seconds) as GeoData)
    }
    draw()
    const timer = setInterval(draw, GLIDE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [mapRef, mapReady, style, aircraft, receivedAtMsRef, onGroundText])
}

/**
 * Follows the traffic topics and draws the network's aircraft (amber) and the sim's own (teal) while main says to.
 *
 * @param args The map, whether it is ready, and whether it is live.
 * @returns The layers and both traffic topics, for the map's buttons and pills.
 */
export function useNetworkTrafficOverlay({
  mapRef,
  mapReady,
  live
}: UseNetworkTrafficOverlayArgs): NetworkTrafficOverlay {
  const client = useLiveClient()
  const { t } = useTranslation()
  const [layers, setLayers] = useState<TrafficLayers | null>(null)
  const [traffic, setTraffic] = useState<NetworkTraffic | null>(null)
  const [simTraffic, setSimTraffic] = useState<SimTraffic | null>(null)
  const networkReceivedAtRef = useRef(0)
  const simReceivedAtRef = useRef(0)
  const onGroundText = t('flightMap.trafficOnGround')

  // The topics: the current value for the first render, then each push. A push stamps this screen's own clock for the glide.
  useEffect(() => {
    if (!live) return
    let current = true
    const takeTraffic = (value: NetworkTraffic): void => {
      networkReceivedAtRef.current = performance.now()
      setTraffic(value)
    }
    const takeSim = (value: SimTraffic): void => {
      simReceivedAtRef.current = performance.now()
      setSimTraffic(value)
    }
    try {
      client.get('networkTraffic').then(
        (v) => current && v && takeTraffic(v),
        (e: unknown) => reportError('map: traffic', e)
      )
      client.get('simTraffic').then(
        (v) => current && v && takeSim(v),
        (e: unknown) => reportError('map: sim traffic', e)
      )
      client.get('trafficLayers').then(
        (v) => current && v && setLayers(v),
        (e: unknown) => reportError('map: traffic layers', e)
      )
      const unsubscribeTraffic = client.subscribe('networkTraffic', takeTraffic)
      const unsubscribeSim = client.subscribe('simTraffic', takeSim)
      const unsubscribeLayers = client.subscribe('trafficLayers', setLayers)
      return () => {
        current = false
        unsubscribeTraffic()
        unsubscribeSim()
        unsubscribeLayers()
      }
    } catch (error) {
      reportError('map: traffic subscribe', error)
      return undefined
    }
  }, [client, live])

  const networkDrawing = live && layers?.drawNetwork === true && traffic?.state === 'shown'
  const simDrawing = live && layers?.drawSim === true && simTraffic?.state === 'shown'
  useDrawnLayer({
    mapRef,
    mapReady,
    style: NETWORK_STYLE,
    aircraft: networkDrawing ? (traffic?.aircraft ?? []) : null,
    receivedAtMsRef: networkReceivedAtRef,
    onGroundText
  })
  useDrawnLayer({
    mapRef,
    mapReady,
    style: SIM_STYLE,
    aircraft: simDrawing ? (simTraffic?.aircraft ?? []) : null,
    receivedAtMsRef: simReceivedAtRef,
    onGroundText
  })

  return { layers, traffic, simTraffic }
}
