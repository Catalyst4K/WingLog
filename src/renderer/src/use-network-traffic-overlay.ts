/**
 * The Track map's online-network traffic layer (winglog-backend docs/plans/vatsim-build.md, Step 1d): the chosen network's aircraft near
 * the pilot as symbols pointing their heading, on the PC and the phone alike (both give FlightMap a LiveClient).
 *
 * Main decides whether the layer draws (`trafficLayers`) and what is on it (`networkTraffic`); this hook only draws. Nothing is added to
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
import type { NetworkTraffic, TrafficLayers } from '@shared/ipc'
import { useLiveClient } from './live/LiveClient'
import { reportError } from './report-error'
import { setSourceData } from './map-source'
import { addTrafficIcon, TRAFFIC_ICON_ID } from './flight-map/traffic-icon'
import { popupLines, trafficFeatures, type TrafficFeatureProperties } from './flight-map/traffic-features'

/** How often the aircraft are moved on, milliseconds. A source update per frame would cost more than it shows. */
export const GLIDE_INTERVAL_MS = 1000

const SOURCE_ID = 'network-traffic'
const AIR_LAYER_ID = `${SOURCE_ID}-air`
const GROUND_LAYER_ID = `${SOURCE_ID}-ground`
const LAYER_IDS = [AIR_LAYER_ID, GROUND_LAYER_ID]

/** The network's colour: amber, which contrasts with the own aircraft's blue in both themes. */
const NETWORK_COLOR = '#f59f00'

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
 * @param popupText Builds the popup's lines for a clicked symbol.
 */
function ensureTrafficLayers(
  map: MapLibreMap,
  popupText: (properties: TrafficFeatureProperties) => string[]
): void {
  if (map.getSource(SOURCE_ID)) return
  addTrafficIcon(map)
  map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  const dark = document.documentElement.classList.contains('dark')
  const textPaint = {
    'text-color': dark ? '#ffd8a8' : '#7a4a00',
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
    id: AIR_LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    filter: ['!', ['get', 'onGround']],
    layout: layout(AIR_ICON_SIZE, AIR_LABEL_MINZOOM) as never,
    paint: { 'icon-color': NETWORK_COLOR, ...textPaint }
  })
  map.addLayer({
    id: GROUND_LAYER_ID,
    type: 'symbol',
    source: SOURCE_ID,
    filter: ['get', 'onGround'],
    layout: layout(GROUND_ICON_SIZE, GROUND_LABEL_MINZOOM) as never,
    paint: {
      'icon-color': NETWORK_COLOR,
      'icon-opacity': GROUND_OPACITY,
      'text-opacity': GROUND_OPACITY,
      ...textPaint
    }
  })
  for (const id of LAYER_IDS)
    map.on('click', id, (event) => {
      const feature: MapGeoJSONFeature | undefined = event.features?.[0]
      if (!feature) return
      openPopup(map, event.lngLat, popupText(feature.properties as TrafficFeatureProperties))
    })
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
 * @param visible Whether they should be seen.
 */
function setVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of LAYER_IDS)
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
}

/**
 * Follows the two traffic topics and draws the network's aircraft while main says to.
 *
 * @param args The map, whether it is ready, and whether it is live.
 * @returns The layers and traffic, for the map's button and pills.
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
  const receivedAtMsRef = useRef(0)
  const createdRef = useRef(false)
  const onGroundText = t('flightMap.trafficOnGround')

  // The topics: the current value for the first render, then each push. A push stamps this screen's own clock for the glide.
  useEffect(() => {
    if (!live) return
    let current = true
    const takeTraffic = (value: NetworkTraffic): void => {
      receivedAtMsRef.current = performance.now()
      setTraffic(value)
    }
    try {
      client.get('networkTraffic').then(
        (v) => current && v && takeTraffic(v),
        (e: unknown) => reportError('map: traffic', e)
      )
      client.get('trafficLayers').then(
        (v) => current && v && setLayers(v),
        (e: unknown) => reportError('map: traffic layers', e)
      )
      const unsubscribeTraffic = client.subscribe('networkTraffic', takeTraffic)
      const unsubscribeLayers = client.subscribe('trafficLayers', setLayers)
      return () => {
        current = false
        unsubscribeTraffic()
        unsubscribeLayers()
      }
    } catch (error) {
      reportError('map: traffic subscribe', error)
      return undefined
    }
  }, [client, live])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const aircraft = traffic?.state === 'shown' ? traffic.aircraft : []
    const drawing = live && layers?.drawNetwork === true && traffic?.state === 'shown'
    if (!drawing) {
      if (createdRef.current) setVisible(map, false)
      return
    }
    if (!createdRef.current) {
      ensureTrafficLayers(map, (properties) => popupLines(properties, onGroundText))
      createdRef.current = true
    }
    setVisible(map, true)
    const draw = (): void => {
      const seconds = (performance.now() - receivedAtMsRef.current) / 1000
      setSourceData(map, SOURCE_ID, trafficFeatures(aircraft, seconds) as GeoData)
    }
    draw()
    const timer = setInterval(draw, GLIDE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [mapRef, mapReady, live, layers, traffic, onGroundText])

  return { layers, traffic }
}
